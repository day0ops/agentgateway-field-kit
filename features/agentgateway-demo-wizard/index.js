import { Feature, FeatureManager } from '../../src/lib/feature.js';
import {
  CertificateHelper,
  waitForPublicUrl,
  nlbSourceRangeAnnotations,
} from '../../src/lib/common.js';

const DEFAULT_IMAGE =
  'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/agentgateway-demo-wizard:v0.1.0';

/**
 * Agentgateway Demo Wizard Feature
 *
 * Deploys the clickops demo-wizard app (github.com/day0ops/agentgateway-demo-wizard):
 * a Deployment+Service for the wizard's single container image, namespace-scoped
 * RBAC matching exactly what the wizard's own README documents it needs, a Secret
 * for its container env, and (optionally) its own dedicated HTTPS Gateway +
 * cert-manager Certificate + HTTPRoute, VPN-locked via sourceRanges - the same
 * shape addons/solo-ui uses for its own public exposure.
 *
 * Also bundles the 'routing-dynamic' HTTPRoute the wizard's dynamic-tier routing
 * step expects to find (X-Model-Tier header match against two pre-provisioned
 * backends), and (when hostname+tls are set) a second, more specific HTTPRoute
 * at PathPrefix /secure for the auth pillar's ext-auth-gated login/ops-agent
 * endpoints - Gateway API's longest-path-match precedence leaves every other
 * path resolving to the existing, ungated '/' route - see
 * docs/superpowers/specs/2026-10-08-demo-wizard-field-kit-integration-design.md
 * for the full naming contract this usecase and the wizard's own registry agree on.
 *
 * Configuration:
 * {
 *   namespace: string,       // Default: 'agentgateway-system'
 *   image: string,           // Default: the v0.1.0 GAR image
 *   agwHost: string,         // AGW_HOST env var for the wizard container
 *   keycloakHost: string,    // KEYCLOAK_HOST env var for the wizard container
 *   hostname: string,        // Optional: public hostname for HTTPS (e.g. 'wizard.example.com')
 *   tls: {                   // Optional: TLS config (requires hostname)
 *     enabled: boolean,      // Default: false
 *     secretName: string,    // Default: 'agentgateway-demo-wizard-tls'
 *     issuer: string,        // ClusterIssuer name (e.g. 'letsencrypt-dns')
 *   },
 *   sourceRanges: string[],  // CIDR allowlist for the dedicated Gateway's NLB
 * }
 *
 * Required environment variables (validated in validate()): OPENAI_API_KEY,
 * OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET. DEMO_USER_PASSWORD defaults to 'Password1!'
 * (the literal baked into every profile's agw-dev realm config) when unset.
 */
export class AgentgatewayDemoWizardFeature extends Feature {
  static REQUIRES_GATEWAY = true;

  constructor(name, config) {
    super(name, config);
    this.image = config.image || DEFAULT_IMAGE;
    this.agwHost = config.agwHost || '';
    this.keycloakHost = config.keycloakHost || '';
    this.hostname = config.hostname || null;
    this.tls = config.tls || null;
    this.sourceRanges = config.sourceRanges || null;
  }

  getFeaturePath() {
    return this.name;
  }

  validate() {
    const required = ['OPENAI_API_KEY', 'OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET'];
    const missing = required.filter(v => !process.env[v]);
    if (missing.length > 0) {
      throw new Error(
        `agentgateway-demo-wizard requires environment variable(s): ${missing.join(', ')}`
      );
    }
    return true;
  }

  async deploy() {
    this.log('Deploying agentgateway-demo-wizard...', 'info');

    await this.applyYamlFile('serviceaccount.yaml');
    await this.applyYamlFile('role.yaml');
    await this.applyYamlFile('rolebinding.yaml');

    await this.deploySecret();
    await this.deployWorkload();
    await this.deployRoutingDynamicRoute();

    if (this.hostname && this.tls?.enabled) {
      await this.applyHttpsResources();
      await this.deploySecureRoute();
    }

    this.accessHint = this.hostname
      ? `Access at https://${this.hostname}/`
      : `Port-forward with: kubectl port-forward service/agentgateway-demo-wizard -n ${this.namespace} 8080:8080`;

    this.log('agentgateway-demo-wizard deployed', 'success');
  }

  async deploySecret() {
    await this.applyResource({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'agentgateway-demo-wizard-env',
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      type: 'Opaque',
      stringData: {
        OPENAI_API_KEY: this.dryRun ? '<set OPENAI_API_KEY>' : process.env.OPENAI_API_KEY,
        OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET: this.dryRun
          ? '<set OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET>'
          : process.env.OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET,
        DEMO_USER_PASSWORD: process.env.DEMO_USER_PASSWORD || 'Password1!',
      },
    });
  }

  async deployWorkload() {
    await this.applyYamlFile('deployment.yaml', {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'wizard',
                image: this.image,
                imagePullPolicy: 'Always',
                ports: [{ containerPort: 8080, name: 'http' }],
                env: [
                  { name: 'AGW_HOST', value: this.agwHost },
                  { name: 'KEYCLOAK_HOST', value: this.keycloakHost },
                  { name: 'WIZARD_ADDR', value: ':8080' },
                ],
                envFrom: [{ secretRef: { name: 'agentgateway-demo-wizard-env' } }],
                resources: {
                  requests: { cpu: '100m', memory: '128Mi' },
                  limits: { cpu: '500m', memory: '512Mi' },
                },
              },
            ],
          },
        },
      },
    });
    await this.applyYamlFile('service.yaml');
    this.log('Deployment and Service applied', 'info');
  }

  async deployRoutingDynamicRoute() {
    const gatewayRef = FeatureManager.getGatewayRef();
    await this.applyYamlFile('routing-dynamic-route.yaml', {
      spec: {
        parentRefs: [{ name: gatewayRef.name, namespace: gatewayRef.namespace }],
      },
    });
    this.log('routing-dynamic HTTPRoute applied (X-Model-Tier header match)', 'info');
  }

  async applyHttpsResources() {
    this.log(`Configuring HTTPS for the wizard at https://${this.hostname}...`, 'info');

    const secretName = this.tls.secretName || 'agentgateway-demo-wizard-tls';
    const issuerName = this.tls.issuer || 'letsencrypt-dns';

    await this.applyYamlFile('certificate.yaml', {
      spec: {
        secretName,
        issuerRef: { name: issuerName },
        dnsNames: [this.hostname],
      },
    });

    await this.applyYamlFile('https-gateway.yaml', {
      spec: {
        listeners: [
          {
            name: 'https',
            port: 443,
            protocol: 'HTTPS',
            hostname: this.hostname,
            tls: {
              mode: 'Terminate',
              certificateRefs: [{ name: secretName, kind: 'Secret' }],
            },
            allowedRoutes: { namespaces: { from: 'All' } },
          },
        ],
        infrastructure: { annotations: nlbSourceRangeAnnotations(this.sourceRanges) },
      },
    });

    await this.applyYamlFile('https-route.yaml', {
      spec: {
        hostnames: [this.hostname],
        rules: [
          {
            backendRefs: [{ name: 'agentgateway-demo-wizard', port: 8080 }],
            matches: [{ path: { type: 'PathPrefix', value: '/' } }],
          },
        ],
      },
    });

    if (!this.dryRun && CertificateHelper.isExternalHostname(this.hostname)) {
      await waitForPublicUrl(this.hostname, {
        protocol: 'https',
        spinner: this.spinner,
        log: (msg, level) => this.log(msg, level),
      });
    }

    this.log('HTTPS resources applied', 'info');
  }

  async deploySecureRoute() {
    await this.applyYamlFile('secure-route.yaml', {
      spec: {
        hostnames: [this.hostname],
      },
    });
    this.log(
      'agentgateway-demo-wizard-secure HTTPRoute applied (ext-auth-gated /secure prefix)',
      'info'
    );
  }

  async cleanup() {
    this.log('Cleaning up agentgateway-demo-wizard...', 'info');

    await this.deleteResource('HTTPRoute', 'routing-dynamic', this.namespace);

    if (this.hostname && this.tls?.enabled) {
      await this.deleteResource('HTTPRoute', 'agentgateway-demo-wizard-secure', this.namespace);
      await this.deleteResource('HTTPRoute', 'agentgateway-demo-wizard', this.namespace);
      await this.deleteResource('Gateway', 'agentgateway-demo-wizard-https', this.namespace);
      await this.deleteResource('Certificate', 'agentgateway-demo-wizard-tls', this.namespace);
    }

    await this.deleteResource('Service', 'agentgateway-demo-wizard', this.namespace);
    await this.deleteResource('Deployment', 'agentgateway-demo-wizard', this.namespace);
    await this.deleteResource('Secret', 'agentgateway-demo-wizard-env', this.namespace);
    await this.deleteResource('RoleBinding', 'agentgateway-demo-wizard', this.namespace);
    await this.deleteResource('Role', 'agentgateway-demo-wizard', this.namespace);
    await this.deleteResource('ServiceAccount', 'agentgateway-demo-wizard', this.namespace);

    this.log('agentgateway-demo-wizard cleaned up', 'success');
  }
}

export function createAgentgatewayDemoWizardFeature(config) {
  return new AgentgatewayDemoWizardFeature('agentgateway-demo-wizard', config);
}

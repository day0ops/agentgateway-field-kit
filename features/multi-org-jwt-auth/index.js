import { Feature } from '../../src/lib/feature.js';
import { EDITION_GATEWAY_NAME, BACKEND_API_GROUP, BACKEND_KIND } from '../../src/lib/editions.js';

const DEFAULT_KEYCLOAK_HOST = 'keycloak.keycloak.svc.cluster.local';

export class MultiOrgJwtAuthFeature extends Feature {
  // Enterprise-only multi-org JWT routing, confirmed no reusable OSS primitive exists.
  static SUPPORTED_EDITIONS = ['enterprise'];

  get keycloakHost() {
    return this.config.keycloakHost || DEFAULT_KEYCLOAK_HOST;
  }

  get gatewayName() {
    return this.config.gatewayName || EDITION_GATEWAY_NAME[this.edition];
  }

  get orgRealms() {
    return this.config.orgRealms || [];
  }

  // Whether to project org_id/team_id claims into x-gw-org-id/x-gw-team-id headers.
  // Only meaningful for realms that actually carry those claims (see multi-org-jwt-routing).
  get injectOrgHeaders() {
    return this.config.injectOrgHeaders !== false;
  }

  // Path clients call, and the backend path it's rewritten to. Defaults reproduce the
  // original org-routing/echo behavior; override for realms with unrelated claim shapes
  // or when the route needs to preserve the original HTTP method (e.g. httpbin's /anything).
  get routePath() {
    return this.config.routePath || '/org-routing/echo';
  }

  get rewritePath() {
    return this.config.rewritePath || '/headers';
  }

  getFeaturePath() {
    return 'multi-org-jwt-auth';
  }

  async deploy() {
    this.log('Deploying multi-org JWT auth feature...', 'info');

    await this.deployKeycloakJwksBackend();
    await this.deployJwtPolicy();
    await this.deployEchoBackend();
    await this.applyYamlFile('echo-httproute.yaml', {
      spec: {
        parentRefs: [{ name: this.gatewayName, namespace: this.namespace }],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: this.routePath } }],
            filters: [
              {
                type: 'URLRewrite',
                urlRewrite: {
                  path: { type: 'ReplacePrefixMatch', replacePrefixMatch: this.rewritePath },
                },
              },
            ],
            backendRefs: [{ name: 'echo-backend', port: 80 }],
          },
        ],
      },
    });

    this.log('Multi-org JWT auth feature deployed', 'success');
  }

  async deployKeycloakJwksBackend() {
    const backend = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: 'keycloak-jwks',
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': 'multi-org-jwt-auth',
        },
      },
      spec: {
        policies: {
          tls: {
            sni: this.keycloakHost,
          },
        },
        static: {
          host: this.keycloakHost,
          port: 443,
        },
      },
    };
    await this.applyResource(backend);
  }

  async deployJwtPolicy() {
    if (!this.orgRealms.length) {
      throw new Error('MultiOrgJwtAuthFeature requires at least one orgRealm in config.orgRealms');
    }

    const providers = this.orgRealms.map(({ realm }) => ({
      issuer: `https://${this.keycloakHost}/realms/${realm}`,
      audiences: ['account'],
      jwks: {
        remote: {
          jwksPath: `realms/${realm}/protocol/openid-connect/certs`,
          cacheDuration: '5m',
          backendRef: {
            group: BACKEND_API_GROUP[this.edition],
            kind: BACKEND_KIND[this.edition],
            name: 'keycloak-jwks',
            namespace: this.namespace,
          },
        },
      },
    }));

    const policy = {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: {
        name: 'multi-org-jwt-auth',
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': 'multi-org-jwt-auth',
        },
      },
      spec: {
        targetRefs: [
          {
            group: 'gateway.networking.k8s.io',
            kind: 'Gateway',
            name: this.gatewayName,
          },
        ],
        traffic: {
          phase: 'PreRouting',
          jwtAuthentication: {
            mode: 'Strict',
            providers,
          },
          ...(this.injectOrgHeaders && {
            transformation: {
              request: {
                set: [
                  { name: 'x-gw-org-id', value: "jwt['org_id']" },
                  { name: 'x-gw-team-id', value: "jwt['team_id']" },
                ],
              },
            },
          }),
        },
      },
    };

    await this.applyResource(policy);
  }

  async deployEchoBackend() {
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'echo-backend',
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': 'multi-org-jwt-auth',
          app: 'echo-backend',
        },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'echo-backend' } },
        template: {
          metadata: {
            labels: { app: 'echo-backend', 'agentgateway.dev/feature': 'multi-org-jwt-auth' },
          },
          spec: {
            containers: [
              {
                name: 'httpbin',
                image: 'kennethreitz/httpbin',
                ports: [{ containerPort: 80 }],
                resources: {
                  requests: { cpu: '50m', memory: '64Mi' },
                  limits: { cpu: '200m', memory: '128Mi' },
                },
              },
            ],
          },
        },
      },
    };

    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'echo-backend',
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': 'multi-org-jwt-auth',
        },
      },
      spec: {
        selector: { app: 'echo-backend' },
        ports: [{ port: 80, targetPort: 80 }],
      },
    };

    await this.applyResource(deployment);
    await this.applyResource(service);
  }

  async cleanup() {
    this.log('Cleaning up multi-org JWT auth feature...', 'info');
    await this.deleteByLabel(BACKEND_KIND[this.edition], {
      'agentgateway.dev/feature': 'multi-org-jwt-auth',
    });
    await this.deleteByLabel('EnterpriseAgentgatewayPolicy', {
      'agentgateway.dev/feature': 'multi-org-jwt-auth',
    });
    await this.deleteByLabel('HTTPRoute', {
      'agentgateway.dev/feature': 'multi-org-jwt-auth',
    });
    await this.deleteByLabel('Service', {
      'agentgateway.dev/feature': 'multi-org-jwt-auth',
    });
    await this.deleteByLabel('Deployment', {
      'agentgateway.dev/feature': 'multi-org-jwt-auth',
    });
    this.log('Multi-org JWT auth feature cleaned up', 'success');
  }
}

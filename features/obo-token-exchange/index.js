import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, 'config');

/**
 * OBO Token Exchange Feature
 *
 * Applies a JWT authentication policy (EnterpriseAgentgatewayPolicy) that
 * protects target routes with tokens issued by the STS token exchange server.
 * The STS itself is enabled via the profile's Helm values (tokenExchange.*).
 *
 * LEGACY (STS-based, still current for what it's used for): this feature's consumers
 * (fd-loan-rbac-jwt-propagation, workload-identity-chain,
 * agent-workload-identity) are all Delegation demos - the calling agent explicitly
 * exchanges its own Keycloak token plus a K8s ServiceAccount actor token at the STS
 * before calling downstream, preserving an `act` claim for auditing. That's an
 * agent-driven pattern with no proxy-native (backend.auth.oauthTokenExchange)
 * equivalent yet, so these usecases correctly stay on the STS. For Impersonation or
 * External IdP exchange specifically (no `act` claim, no agent-side STS call needed),
 * prefer oauth-token-exchange instead - see obo-token-exchange.yaml/
 * obo-entra-token-exchange.yaml.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/mcp/token-exchange/obo/
 *
 * This feature:
 * - Optionally configures Keycloak realm and clients via the Admin API
 * - Creates an EnterpriseAgentgatewayPolicy with JWT authentication
 *   that validates OBO-exchanged tokens on target HTTPRoutes
 *
 * Configuration:
 * {
 *   policyName: string,                 // Default: 'obo-jwt-policy'
 *   keycloak: {
 *     realm: string,                    // Default: 'agw-dev'
 *     serviceName: string,              // Default: 'keycloak'
 *     serviceNamespace: string,         // Default: 'keycloak'
 *     servicePort: number,              // Default: 443 (TLS policy auto-added for 443/8443)
 *     jwksPath: string,                 // Default: 'realms/<realm>/protocol/openid-connect/certs'
 *   },
 *   issuer: string,                     // Default: 'https://<serviceName>.<serviceNamespace>.svc.cluster.local/realms/<realm>'
 *   jwksBackend: {                      // Override the JWKS backend (e.g. AGW STS instead of Keycloak)
 *     name: string,                     // K8s Service name
 *     namespace: string,                // K8s Service namespace
 *     port: number,                     // K8s Service port
 *   },
 *   jwksPath: string,                   // Override JWKS path (required when jwksBackend is set)
 *   jwtMode: string,                    // Default: 'Strict'
 *   audiences: Array<string>,           // Optional audience restriction
 *   cacheDuration: string,              // Default: '5m'
 *   targetRefs: Array<{                 // Routes to protect with JWT auth
 *     group: string,
 *     kind: string,
 *     name: string,
 *   }>,
 * }
 */
export class OboTokenExchangeFeature extends Feature {
  // Depends on the control-plane STS/token-exchange listener, which has no OSS equivalent.
  // OSS's backendAuth.oauthTokenExchange solves gateway-to-backend auth, a different problem.
  static SUPPORTED_EDITIONS = ['enterprise'];

  constructor(name, config) {
    super(name, config);

    this.policyName = config.policyName || 'obo-jwt-policy';

    this.jwksBackend = config.jwksBackend || null;

    const kc = config.keycloak || {};
    this.realm = kc.realm || 'agw-dev';
    this.keycloakServiceName = kc.serviceName || 'keycloak';
    this.keycloakServiceNamespace = kc.serviceNamespace || 'keycloak';
    this.keycloakServicePort = kc.servicePort || 443;
    this.jwksPath =
      config.jwksPath || kc.jwksPath || `realms/${this.realm}/protocol/openid-connect/certs`;

    const keycloakHost = `${this.keycloakServiceName}.${this.keycloakServiceNamespace}.svc.cluster.local`;
    this.issuer = config.issuer || `https://${keycloakHost}/realms/${this.realm}`;

    this.jwtMode = config.jwtMode || 'Strict';
    this.audiences = config.audiences || null;
    this.cacheDuration = config.cacheDuration || '5m';
    this.targetRefs = config.targetRefs || null;
  }

  getFeaturePath() {
    return 'obo-token-exchange';
  }

  validate() {
    return true;
  }

  async deploy() {
    this.log('Configuring OBO token exchange JWT policy...', 'info');

    if (
      !this.jwksBackend &&
      (this.keycloakServicePort === 443 || this.keycloakServicePort === 8443)
    ) {
      await this.deployBackendTlsPolicy();
    }
    await this.deployJwtPolicy();

    this.log('OBO token exchange JWT policy applied', 'success');
  }

  async deployJwtPolicy() {
    const gatewayRef = FeatureManager.getGatewayRef();

    const targetRefs = this.targetRefs || [
      {
        group: 'gateway.networking.k8s.io',
        kind: 'HTTPRoute',
        name: 'mcp',
      },
    ];

    const jwksBackendRef = this.jwksBackend || {
      name: this.keycloakServiceName,
      namespace: this.keycloakServiceNamespace,
      port: this.keycloakServicePort,
    };

    const policy = {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: {
        name: this.policyName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        targetRefs,
        traffic: {
          jwtAuthentication: {
            mode: this.jwtMode,
            providers: [
              {
                issuer: this.issuer,
                ...(this.audiences && { audiences: this.audiences }),
                jwks: {
                  remote: {
                    jwksPath: this.jwksPath,
                    cacheDuration: this.cacheDuration,
                    backendRef: {
                      group: '',
                      kind: 'Service',
                      ...jwksBackendRef,
                    },
                  },
                },
              },
            ],
          },
        },
      },
    };

    await this.applyResource(policy);
    this.log(
      `JWT policy '${this.policyName}' targeting ${targetRefs.map(r => r.name).join(', ')}`,
      'info'
    );
  }

  async deployBackendTlsPolicy() {
    const tlsPolicyName = `${this.keycloakServiceName}-backend-tls`;
    this.log(`Applying backend TLS policy '${tlsPolicyName}'...`, 'info');

    const tlsPolicy = {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: {
        name: tlsPolicyName,
        namespace: this.keycloakServiceNamespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        targetRefs: [
          {
            group: '',
            kind: 'Service',
            name: this.keycloakServiceName,
          },
        ],
        backend: {
          tls: {
            insecureSkipVerify: 'All',
          },
        },
      },
    };

    await this.applyResource(tlsPolicy);
  }

  async cleanup() {
    this.log('Cleaning up OBO token exchange...', 'info');

    await this.deleteResource('EnterpriseAgentgatewayPolicy', this.policyName);
    if (!this.jwksBackend) {
      await this.deleteResource(
        'EnterpriseAgentgatewayPolicy',
        `${this.keycloakServiceName}-backend-tls`,
        this.keycloakServiceNamespace
      );
    }

    this.log('OBO token exchange cleaned up', 'success');
  }
}

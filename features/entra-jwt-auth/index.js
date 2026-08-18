import { Feature } from '../../src/lib/feature.js';
import {
  policyApiVersion,
  POLICY_KIND,
  EDITION_GATEWAY_NAME,
  BACKEND_API_GROUP,
  BACKEND_KIND,
} from '../../src/lib/editions.js';

const ENTRA_HOST = 'login.microsoftonline.com';

/**
 * Entra JWT Auth Feature
 *
 * Validates JWTs issued by Microsoft Entra ID (Azure AD). Mirrors okta-jwt-auth's
 * shape: a static AgentgatewayBackend for JWKS retrieval plus a JWT authentication
 * policy on the Gateway.
 *
 * Issuer/JWKS path follow the v1 token format ("ver": "1.0"), which is the common
 * case per https://docs.solo.io/agentgateway/latest/security/extauth/oauth/entra/ -
 * for v2 tokens, override via config.issuer.
 *
 * Configuration:
 * {
 *   tenantId: string,             // Entra tenant ID (required)
 *   clientId: string,             // App registration client ID; used to build the
 *                                 // default audience `api://<clientId>` (required
 *                                 // unless audiences is set explicitly)
 *   audiences: string[],          // Override the default audience list
 *   issuer: string,               // Override the default v1 issuer
 *   gatewayName: string,          // Override the target Gateway name
 *   tunnelBackendRef: object,     // Optional policies.tunnel.backendRef, routing JWKS
 *                                 // fetches through a corporate proxy (see corporate-proxy feature)
 * }
 */
export class EntraJwtAuthFeature extends Feature {
  get tenantId() {
    return this.config.tenantId;
  }

  get clientId() {
    return this.config.clientId;
  }

  get audiences() {
    return this.config.audiences || [`api://${this.clientId}`];
  }

  get issuer() {
    return this.config.issuer || `https://sts.windows.net/${this.tenantId}/`;
  }

  get gatewayName() {
    return this.config.gatewayName || EDITION_GATEWAY_NAME[this.edition];
  }

  get tunnelBackendRef() {
    return this.config.tunnelBackendRef || null;
  }

  getFeaturePath() {
    return 'entra-jwt-auth';
  }

  async deploy() {
    if (!this.tenantId) {
      throw new Error('EntraJwtAuthFeature requires tenantId in config');
    }
    if (!this.clientId && !this.config.audiences) {
      throw new Error(
        'EntraJwtAuthFeature requires clientId (or an explicit audiences override) in config'
      );
    }

    this.log('Deploying Entra JWT auth feature...', 'info');
    await this.deployEntraJwksBackend();
    await this.deployJwtPolicy();
    this.log('Entra JWT auth feature deployed', 'success');
  }

  async deployEntraJwksBackend() {
    const policies = {
      tls: {
        sni: ENTRA_HOST,
      },
    };
    if (this.tunnelBackendRef) {
      policies.tunnel = { backendRef: this.tunnelBackendRef };
    }

    const backend = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: 'entra-jwks',
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': 'entra-jwt-auth',
        },
      },
      spec: {
        policies,
        static: {
          host: ENTRA_HOST,
          port: 443,
        },
      },
    };

    await this.applyResource(backend);
  }

  async deployJwtPolicy() {
    const policy = {
      apiVersion: policyApiVersion(this.edition),
      kind: POLICY_KIND[this.edition],
      metadata: {
        name: 'entra-jwt-auth',
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': 'entra-jwt-auth',
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
            providers: [
              {
                issuer: this.issuer,
                audiences: this.audiences,
                jwks: {
                  remote: {
                    jwksPath: `/${this.tenantId}/discovery/v2.0/keys`,
                    cacheDuration: '5m',
                    backendRef: {
                      group: BACKEND_API_GROUP[this.edition],
                      kind: BACKEND_KIND[this.edition],
                      name: 'entra-jwks',
                      namespace: this.namespace,
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
  }

  async cleanup() {
    this.log('Cleaning up Entra JWT auth feature...', 'info');
    await this.deleteByLabel(BACKEND_KIND[this.edition], {
      'agentgateway.dev/feature': 'entra-jwt-auth',
    });
    await this.deleteByLabel(POLICY_KIND[this.edition], {
      'agentgateway.dev/feature': 'entra-jwt-auth',
    });
    this.log('Entra JWT auth feature cleaned up', 'success');
  }
}

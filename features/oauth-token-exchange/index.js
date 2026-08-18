import { Feature } from '../../src/lib/feature.js';

const DEFAULT_SUBJECT_TOKEN_TYPE = 'AccessToken';
const DEFAULT_GRANT_TYPE = 'TokenExchange';
const DEFAULT_CLIENT_AUTH_METHOD = 'ClientSecretBasic';

/**
 * Proxy-side OAuth Token Exchange Feature
 *
 * Configures the agentgateway data plane to exchange a caller's token for a new
 * token against a generic OAuth token endpoint (RFC 8693), then forwards the
 * exchanged token to the backend - natively, in the proxy. No STS/controller
 * component is involved and the `tokenExchange` Helm feature does not need to be
 * enabled; this is a different mechanism from the OBO/elicitation flows that
 * `token-exchange`/`obo-token-exchange`/`elicitation-backend` configure, which
 * are all handled by the controller-side Security Token Service (STS).
 *
 * `backend.auth.oauthTokenExchange` replaced an early, now-rejected
 * `backend.tokenExchange.oauth` field in agentgateway v2026.7.0 (the CRD strict-
 * decodes and rejects the old field name outright). Verified against the current
 * shape via docs.solo.io's own worked example
 * (mcp/token-exchange/oauth/standard/), not the older field.
 *
 * Configuration:
 * {
 *   name: string,                    // Resource name prefix (default: 'oauth-token-exchange')
 *   targetRefs: [{ group, kind, name }], // Required - route(s) to protect and exchange on
 *   jwtAuthentication: {              // Validates the caller's JWT at the gateway edge
 *                                     // before any call to the token endpoint (required -
 *                                     // the data plane forwards the token as received,
 *                                     // without pre-validating it, so pair this always)
 *     issuer: string,                 // Required
 *     audiences: string[],
 *     mode: string,                   // Default: 'Strict'
 *     jwks: {
 *       host: string,                 // Required - JWKS host (e.g. Keycloak)
 *       port: number,                 // Default: 443
 *       path: string,                 // Required - JWKS path
 *       cacheDuration: string,        // Default: '5m'
 *       tls: boolean,                 // Originate TLS to this host (default: true - most
 *                                     // real IdPs are HTTPS; set false for a plain-HTTP
 *                                     // in-cluster endpoint)
 *     },
 *   },
 *   tokenEndpoint: {
 *     host: string,                   // Required - OAuth token endpoint host
 *     port: number,                   // Default: 443
 *     path: string,                   // Required - token endpoint path
 *     tls: boolean,                   // Default: true (see jwks.tls above)
 *   },
 *   grantType: string,                // 'TokenExchange' (default, RFC 8693) or 'JwtBearer' (RFC 7523 -
 *                                     // sends the incoming credential as `assertion` instead of
 *                                     // `subject_token`; vendor-specific OBO flows like Microsoft
 *                                     // Entra's are a JwtBearer variant)
 *   audiences: string[],              // `audience` param(s) sent to the token endpoint
 *   scopes: string[],                 // `scope` param(s) sent to the token endpoint
 *   resources: string[],              // RFC 8707 resource indicator(s) sent to the token endpoint
 *   additionalParams: Object,         // Extra form params appended to the token request - values
 *                                     // are CEL expressions, so a literal string must be quoted
 *                                     // (e.g. { requested_token_use: '"on_behalf_of"' } for Entra OBO)
 *   clientAuth: {
 *     method: string,                 // Default: 'ClientSecretBasic'
 *     clientId: string,               // Required
 *     clientSecret: string,           // Or clientSecretEnvVar
 *     clientSecretEnvVar: string,     // Default: 'OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET'
 *     secretKey: string,              // Default: 'client_secret'
 *   },
 *   subjectTokenType: string,         // Default: 'AccessToken'
 * }
 */
export class OauthTokenExchangeFeature extends Feature {
  static SUPPORTED_EDITIONS = ['enterprise'];

  get prefix() {
    return this.config.name || 'oauth-token-exchange';
  }

  get targetRefs() {
    return this.config.targetRefs || [];
  }

  get jwtAuth() {
    return this.config.jwtAuthentication || {};
  }

  get tokenEndpoint() {
    return this.config.tokenEndpoint || {};
  }

  get clientAuth() {
    return this.config.clientAuth || {};
  }

  get audiences() {
    return this.config.audiences || null;
  }

  get scopes() {
    return this.config.scopes || null;
  }

  get resources() {
    return this.config.resources || null;
  }

  get additionalParams() {
    return this.config.additionalParams || null;
  }

  get clientSecret() {
    return (
      this.clientAuth.clientSecret ||
      process.env[this.clientAuth.clientSecretEnvVar || 'OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET'] ||
      ''
    );
  }

  get labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
    };
  }

  get jwksBackendName() {
    return `${this.prefix}-jwks`;
  }

  get tokenEndpointBackendName() {
    return `${this.prefix}-token-endpoint`;
  }

  get clientSecretName() {
    return `${this.prefix}-client-secret`;
  }

  async deploy() {
    if (this.targetRefs.length === 0) {
      throw new Error('oauth-token-exchange requires at least one entry in config.targetRefs');
    }
    if (!this.jwtAuth.issuer || !this.jwtAuth.jwks?.host || !this.jwtAuth.jwks?.path) {
      throw new Error(
        'oauth-token-exchange requires jwtAuthentication.issuer and jwtAuthentication.jwks.host/path'
      );
    }
    if (!this.tokenEndpoint.host || !this.tokenEndpoint.path) {
      throw new Error('oauth-token-exchange requires tokenEndpoint.host and tokenEndpoint.path');
    }
    if (!this.dryRun && !this.clientSecret) {
      throw new Error(
        'oauth-token-exchange requires clientAuth.clientSecret (or clientSecretEnvVar) for a real deploy'
      );
    }

    this.log('Deploying proxy-side OAuth token exchange...', 'info');

    await this.deployJwksBackend();
    await this.deployTokenEndpointBackend();
    await this.deployClientSecret();
    await this.deployPolicy();

    this.log('Proxy-side OAuth token exchange deployed', 'success');
  }

  async deployJwksBackend() {
    const jwks = this.jwtAuth.jwks;
    const backend = {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayBackend',
      metadata: {
        name: this.jwksBackendName,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        static: { host: jwks.host, port: jwks.port || 443 },
        ...(jwks.tls !== false && { policies: { tls: { sni: jwks.host } } }),
      },
    };
    await this.applyResource(backend);
  }

  async deployTokenEndpointBackend() {
    const backend = {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayBackend',
      metadata: {
        name: this.tokenEndpointBackendName,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        static: { host: this.tokenEndpoint.host, port: this.tokenEndpoint.port || 443 },
        ...(this.tokenEndpoint.tls !== false && {
          policies: { tls: { sni: this.tokenEndpoint.host } },
        }),
      },
    };
    await this.applyResource(backend);
  }

  async deployClientSecret() {
    const secretKey = this.clientAuth.secretKey || 'client_secret';
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: this.clientSecretName,
        namespace: this.namespace,
        labels: this.labels,
      },
      type: 'Opaque',
      stringData: {
        [secretKey]: this.dryRun ? '<set clientAuth.clientSecret>' : this.clientSecret,
      },
    };
    await this.applyResource(secret);
  }

  async deployPolicy() {
    const policy = {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: {
        name: this.prefix,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        targetRefs: this.targetRefs,
        traffic: {
          jwtAuthentication: {
            mode: this.jwtAuth.mode || 'Strict',
            providers: [
              {
                issuer: this.jwtAuth.issuer,
                ...(this.jwtAuth.audiences && { audiences: this.jwtAuth.audiences }),
                jwks: {
                  remote: {
                    jwksPath: this.jwtAuth.jwks.path,
                    cacheDuration: this.jwtAuth.jwks.cacheDuration || '5m',
                    backendRef: {
                      group: 'enterpriseagentgateway.solo.io',
                      kind: 'EnterpriseAgentgatewayBackend',
                      name: this.jwksBackendName,
                    },
                  },
                },
              },
            ],
          },
        },
        backend: {
          auth: {
            oauthTokenExchange: {
              backendRef: {
                group: 'enterpriseagentgateway.solo.io',
                kind: 'EnterpriseAgentgatewayBackend',
                name: this.tokenEndpointBackendName,
              },
              // The CRD requires this to match '^/' (unlike jwksPath above, which doesn't).
              path: this.tokenEndpoint.path.startsWith('/')
                ? this.tokenEndpoint.path
                : `/${this.tokenEndpoint.path}`,
              grantType: this.config.grantType || DEFAULT_GRANT_TYPE,
              clientAuth: {
                method: this.clientAuth.method || DEFAULT_CLIENT_AUTH_METHOD,
                clientId: this.clientAuth.clientId,
                secretRef: {
                  name: this.clientSecretName,
                  key: this.clientAuth.secretKey || 'client_secret',
                },
              },
              subjectToken: {
                tokenType: this.config.subjectTokenType || DEFAULT_SUBJECT_TOKEN_TYPE,
              },
              ...(this.audiences && { audiences: this.audiences }),
              ...(this.scopes && { scopes: this.scopes }),
              ...(this.resources && { resources: this.resources }),
              ...(this.additionalParams && { additionalParams: this.additionalParams }),
            },
          },
        },
      },
    };
    await this.applyResource(policy);
  }

  async cleanup() {
    this.log('Cleaning up oauth-token-exchange feature...', 'info');
    await this.deleteByLabel('EnterpriseAgentgatewayPolicy', {
      'agentgateway.dev/feature': this.name,
    });
    await this.deleteResource(
      'EnterpriseAgentgatewayBackend',
      this.tokenEndpointBackendName,
      this.namespace
    );
    await this.deleteResource(
      'EnterpriseAgentgatewayBackend',
      this.jwksBackendName,
      this.namespace
    );
    await this.deleteResource('Secret', this.clientSecretName, this.namespace);
    this.log('oauth-token-exchange feature cleaned up', 'success');
  }
}

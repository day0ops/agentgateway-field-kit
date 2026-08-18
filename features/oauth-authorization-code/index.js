import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { KubernetesHelper, Logger } from '../../src/lib/common.js';

/**
 * OAuth Authorization Code Feature
 *
 * Applies an AuthConfig with OIDC authorization code flow and an
 * EnterpriseAgentgatewayPolicy with external auth (entExtAuth) that
 * protects target routes. Unauthenticated requests are redirected to the
 * IdP (e.g. Keycloak) for login; after authentication the IdP redirects
 * back with an authorization code that is exchanged for an ID token.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/security/extauth/oauth/authorization-code/
 *
 * This feature:
 * - Creates a Kubernetes Secret (type extauth.solo.io/oauth) for the
 *   IdP client credentials
 * - Creates an AuthConfig with oauth2.oidcAuthorizationCode settings
 * - Creates an EnterpriseAgentgatewayPolicy with entExtAuth referencing
 *   the AuthConfig and the ext-auth-service backend
 *
 * Configuration:
 * {
 *   authConfigName: string,          // Default: 'oauth-authorization-code'
 *   policyName: string,              // Default: 'oauth-authorization-code'
 *   secretName: string,              // Default: 'oauth-keycloak'
 *   keycloak: {
 *     realm: string,                 // Default: 'master'
 *     serviceName: string,           // Default: 'keycloak'
 *     serviceNamespace: string,      // Default: 'keycloak'
 *     servicePort: number,           // Default: 443
 *   },
 *   clientId: string,                // OIDC client ID (required, or set KEYCLOAK_CLIENT_ID env)
 *   clientSecret: string,            // Plain-text client secret (falls back to KEYCLOAK_SECRET env)
 *   appUrl: string,                  // Public app URL (default: 'http://localhost:8080')
 *   callbackPath: string,            // Callback path after auth (default: '/openai')
 *   issuerUrl: string,               // Override OIDC issuer URL
 *   scopes: Array<string>,           // Additional scopes (default: ['email'])
 *   session: {
 *     cookieName: string,            // Session cookie name (default: 'keycloak-session')
 *     redisHost: string,             // Redis host:port (default: 'ext-cache-enterprise-agentgateway:6379')
 *   },
 *   headers: {
 *     idTokenHeader: string,         // Header name for forwarded ID token (default: 'jwt')
 *   },
 *   extAuthBackend: {
 *     name: string,                  // Default: 'ext-auth-service-enterprise-agentgateway'
 *     port: number,                  // Default: 8083
 *   },
 *   targetRefs: Array<{
 *     group: string,
 *     kind: string,
 *     name: string,
 *   }>,
 * }
 */
export class OAuthAuthorizationCodeFeature extends Feature {
  // Depends on the ext-auth-service/AuthConfig (extauth.solo.io) subsystem, which has no OSS equivalent.
  static SUPPORTED_EDITIONS = ['enterprise'];

  constructor(name, config) {
    super(name, config);

    this.authConfigName = config.authConfigName || 'oauth-authorization-code';
    this.policyName = config.policyName || 'oauth-authorization-code';
    this.secretName = config.secretName || 'oauth-keycloak';

    const kc = config.keycloak || {};
    this.realm = kc.realm || 'agw-dev';
    this.keycloakServiceName = kc.serviceName || 'keycloak';
    this.keycloakServiceNamespace = kc.serviceNamespace || 'keycloak';
    this.keycloakServicePort = kc.servicePort || 443;

    this.clientId = config.clientId || process.env.KEYCLOAK_CLIENT_ID || 'agw-client';
    this.clientSecret = config.clientSecret || process.env.KEYCLOAK_SECRET || '';
    this.appUrl = config.appUrl || null;
    this.callbackPath = config.callbackPath || '/openai';

    const keycloakHost = `${this.keycloakServiceName}.${this.keycloakServiceNamespace}.svc.cluster.local`;
    this.issuerUrl = config.issuerUrl || `https://${keycloakHost}/realms/${this.realm}/`;

    this.discoveryOverride = config.discoveryOverride || null;

    this.scopes = config.scopes || ['email'];

    const sess = config.session || {};
    this.cookieName = sess.cookieName || 'keycloak-session';
    this.redisHost = sess.redisHost || 'ext-cache-enterprise-agentgateway:6379';

    const hdrs = config.headers || {};
    this.idTokenHeader = hdrs.idTokenHeader || 'jwt';

    const extAuth = config.extAuthBackend || {};
    this.extAuthServiceName = extAuth.name || 'ext-auth-service-enterprise-agentgateway';
    this.extAuthServicePort = extAuth.port || 8083;

    this.targetRefs = config.targetRefs || null;
  }

  getFeaturePath() {
    return 'oauth-authorization-code';
  }

  validate() {
    if (!this.clientId) {
      throw new Error(
        'OAuth authorization code requires a clientId. ' +
          'Set it in the use case config or via the KEYCLOAK_CLIENT_ID environment variable.'
      );
    }
    return true;
  }

  async deploy() {
    this.log('Configuring OAuth authorization code flow...', 'info');

    if (!this.appUrl) {
      this.appUrl = await this.resolveAppUrl();
    }

    await this.deployOAuthSecret();
    await this.deployAuthConfig();
    await this.deployExtAuthPolicy();

    this.log('OAuth authorization code policy applied', 'success');
  }

  async resolveAppUrl() {
    const gatewayRef = FeatureManager.getGatewayRef();
    const port = await this.resolveGatewayHttpPort(gatewayRef);

    if (process.env.INGRESS_GW_ADDRESS) {
      return `http://${process.env.INGRESS_GW_ADDRESS}:${port}`;
    }

    try {
      const result = await KubernetesHelper.kubectl(
        [
          'get',
          'gateway',
          gatewayRef.name,
          '-n',
          gatewayRef.namespace,
          '-o',
          'jsonpath={.status.addresses[0].value}',
        ],
        { ignoreError: true }
      );

      const addr = result.stdout.trim();
      if (addr) {
        return `http://${addr}:${port}`;
      }
    } catch {
      // fall through to default
    }

    Logger.warn('Could not resolve gateway address for appUrl, using localhost fallback');
    return 'http://localhost:8080';
  }

  /**
   * The Gateway's own HTTP listener port - NOT necessarily 80. The LoadBalancer Service
   * only exposes whatever ports the Gateway's listeners declare (this repo's default
   * profile uses 8080 for plain HTTP), so a hardcoded :80 in the redirect_uri produces a
   * URL nothing is listening on, breaking the callback for every real browser too, not
   * just automated tests.
   */
  async resolveGatewayHttpPort(gatewayRef) {
    try {
      const result = await KubernetesHelper.kubectl(
        [
          'get',
          'gateway',
          gatewayRef.name,
          '-n',
          gatewayRef.namespace,
          '-o',
          'jsonpath={.spec.listeners[?(@.protocol=="HTTP")].port}',
        ],
        { ignoreError: true }
      );
      const port = parseInt(result.stdout.trim(), 10);
      if (Number.isInteger(port)) return port;
    } catch {
      // fall through to default
    }
    return 8080;
  }

  async deployOAuthSecret() {
    const clientSecret =
      this.dryRun && !this.clientSecret
        ? '<set clientSecret or KEYCLOAK_SECRET>'
        : this.clientSecret;

    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: this.secretName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      type: 'extauth.solo.io/oauth',
      stringData: {
        'client-secret': clientSecret,
      },
    };

    await this.applyResource(secret);
    this.log(`Secret '${this.secretName}' created`, 'info');
  }

  async deployAuthConfig() {
    const [redisHostName, redisPort] = this.redisHost.includes(':')
      ? this.redisHost.split(':')
      : [this.redisHost, '6379'];

    const authConfig = {
      apiVersion: 'extauth.solo.io/v1',
      kind: 'AuthConfig',
      metadata: {
        name: this.authConfigName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        configs: [
          {
            oauth2: {
              oidcAuthorizationCode: {
                appUrl: this.appUrl,
                callbackPath: this.callbackPath,
                clientId: this.clientId,
                clientSecretRef: {
                  name: this.secretName,
                  namespace: this.namespace,
                },
                issuerUrl: this.issuerUrl,
                ...(this.discoveryOverride && { discoveryOverride: this.discoveryOverride }),
                scopes: this.scopes,
                session: {
                  failOnFetchFailure: true,
                  redis: {
                    cookieName: this.cookieName,
                    options: {
                      host: `${redisHostName}:${redisPort}`,
                    },
                  },
                },
                headers: {
                  idTokenHeader: this.idTokenHeader,
                },
              },
            },
          },
        ],
      },
    };

    await this.applyResource(authConfig);
    this.log(`AuthConfig '${this.authConfigName}' created`, 'info');
  }

  async deployExtAuthPolicy() {
    const gatewayRef = FeatureManager.getGatewayRef();

    const targetRefs = this.targetRefs || [
      {
        group: 'gateway.networking.k8s.io',
        kind: 'Gateway',
        name: gatewayRef.name,
      },
    ];

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
          entExtAuth: {
            authConfigRef: {
              name: this.authConfigName,
              namespace: this.namespace,
            },
            backendRef: {
              name: this.extAuthServiceName,
              namespace: this.namespace,
              port: this.extAuthServicePort,
            },
          },
        },
      },
    };

    await this.applyResource(policy);
    this.log(
      `EnterpriseAgentgatewayPolicy '${this.policyName}' targeting ${targetRefs.map(r => r.name).join(', ')}`,
      'info'
    );
  }

  async cleanup() {
    this.log('Cleaning up OAuth authorization code...', 'info');

    await this.deleteResource('EnterpriseAgentgatewayPolicy', this.policyName);
    await this.deleteResource('AuthConfig', this.authConfigName);
    await this.deleteResource('Secret', this.secretName);

    this.log('OAuth authorization code cleaned up', 'success');
  }
}

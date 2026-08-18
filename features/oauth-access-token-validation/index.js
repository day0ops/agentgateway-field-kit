import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { KubernetesHelper, Logger } from '../../src/lib/common.js';

/**
 * OAuth Access Token Validation Feature
 *
 * Applies an AuthConfig with OAuth2 access token validation (JWT) and an
 * EnterpriseAgentgatewayPolicy with external auth (entExtAuth) that
 * protects target routes. Requests without a valid JWT access token
 * receive a 403 Forbidden response.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/security/extauth/oauth/access-token/
 *
 * This feature:
 * - Creates an AuthConfig with oauth2.accessTokenValidation.jwt settings
 *   using either local (inline) or remote JWKS
 * - Creates an EnterpriseAgentgatewayPolicy with entExtAuth referencing
 *   the AuthConfig and the ext-auth-service backend
 *
 * Configuration:
 * {
 *   authConfigName: string,          // Default: 'oauth-jwt-validation'
 *   policyName: string,              // Default: 'oauth-jwt-validation'
 *   keycloak: {
 *     realm: string,                 // Default: 'agw-dev'
 *     serviceName: string,           // Default: 'keycloak'
 *     serviceNamespace: string,      // Default: 'keycloak'
 *     servicePort: number,           // Default: 443
 *     jwksPath: string,              // Default: 'realms/<realm>/protocol/openid-connect/certs'
 *     externalUrl: string,           // Public Keycloak URL (scheme://host). The ext-auth-service
 *                                     // pod fetches the JWKS itself, bypassing agentgateway's own
 *                                     // Backend/TLS-policy layer entirely - if Keycloak's TLS cert
 *                                     // is issued for its public hostname (the usual case), the
 *                                     // default in-cluster Service DNS name fails certificate
 *                                     // verification. Set this to match the cert. Default: none
 *                                     // (uses the in-cluster Service DNS name).
 *   },
 *   jwksMode: string,                // 'remote' (default) or 'inline'
 *   inlineJwks: string,              // Pre-fetched JWKS JSON (only when jwksMode='inline')
 *   issuer: string,                  // Override OIDC issuer URL
 *   cacheDuration: string,           // JWKS cache duration for remote mode (default: '5m')
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
export class OAuthAccessTokenValidationFeature extends Feature {
  // Depends on the ext-auth-service/AuthConfig (extauth.solo.io) subsystem, which has no OSS equivalent.
  static SUPPORTED_EDITIONS = ['enterprise'];

  constructor(name, config) {
    super(name, config);

    this.authConfigName = config.authConfigName || 'oauth-jwt-validation';
    this.policyName = config.policyName || 'oauth-jwt-validation';

    const kc = config.keycloak || {};
    this.realm = kc.realm || 'agw-dev';
    this.keycloakServiceName = kc.serviceName || 'keycloak';
    this.keycloakServiceNamespace = kc.serviceNamespace || 'keycloak';
    this.keycloakServicePort = kc.servicePort || 443;
    this.jwksPath = kc.jwksPath || `realms/${this.realm}/protocol/openid-connect/certs`;

    const keycloakHost = `${this.keycloakServiceName}.${this.keycloakServiceNamespace}.svc.cluster.local`;
    this.keycloakExternalUrl = kc.externalUrl || null;
    const issuerBase = this.keycloakExternalUrl || `https://${keycloakHost}`;
    this.issuer = config.issuer || `${issuerBase}/realms/${this.realm}`;

    this.jwksMode = config.jwksMode || 'remote';
    this.inlineJwks = config.inlineJwks || process.env.KEYCLOAK_CERT_KEYS || null;
    this.cacheDuration = config.cacheDuration || '5m';

    const extAuth = config.extAuthBackend || {};
    this.extAuthServiceName = extAuth.name || 'ext-auth-service-enterprise-agentgateway';
    this.extAuthServicePort = extAuth.port || 8083;

    this.targetRefs = config.targetRefs || null;
  }

  getFeaturePath() {
    return 'oauth-access-token-validation';
  }

  validate() {
    if (this.jwksMode === 'inline' && !this.inlineJwks) {
      throw new Error(
        'Access token validation with inline JWKS requires inlineJwks config or KEYCLOAK_CERT_KEYS env var.'
      );
    }
    return true;
  }

  async deploy() {
    this.log('Configuring OAuth access token validation...', 'info');

    if (this.keycloakServicePort === 443 || this.keycloakServicePort === 8443) {
      await this.deployBackendTlsPolicy();
    }
    await this.deployAuthConfig();
    await this.deployExtAuthPolicy();

    this.log('Access token validation policy applied', 'success');
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

  async deployAuthConfig() {
    const accessTokenConfig = {};

    if (this.jwksMode === 'inline') {
      accessTokenConfig.jwt = {
        localJwks: {
          inlineString: this.inlineJwks,
        },
      };
    } else {
      const jwksHost =
        this.keycloakExternalUrl ||
        `https://${this.keycloakServiceName}.${this.keycloakServiceNamespace}.svc.cluster.local`;
      accessTokenConfig.jwt = {
        remoteJwks: {
          url: `${jwksHost}/${this.jwksPath}`,
          cacheDuration: this.cacheDuration,
        },
      };
    }

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
              accessTokenValidation: accessTokenConfig,
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
    this.log('Cleaning up access token validation...', 'info');

    await this.deleteResource('EnterpriseAgentgatewayPolicy', this.policyName);
    await this.deleteResource('AuthConfig', this.authConfigName);
    await this.deleteResource(
      'EnterpriseAgentgatewayPolicy',
      `${this.keycloakServiceName}-backend-tls`,
      this.keycloakServiceNamespace
    );

    this.log('Access token validation cleaned up', 'success');
  }
}

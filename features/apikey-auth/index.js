import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { randomBytes } from 'crypto';

/**
 * API Key Auth Feature
 *
 * Secures routes with API key authentication via ext-auth. Creates a
 * Kubernetes Secret holding the API key, an AuthConfig with apiKeyAuth,
 * and an EnterpriseAgentgatewayPolicy with entExtAuth.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/security/apikey/
 *
 * Configuration:
 * {
 *   secretName: string,                // Default: 'apikey'
 *   apiKey: string,                    // The API key value (auto-generated if omitted)
 *   headerName: string,               // Request header holding the key (default: 'x-ai-api-key')
 *   labelSelector: Record<string,string>, // Labels for selecting API key secrets
 *                                        // Default: { provider: 'openai' }
 *   authConfigName: string,           // Default: 'apikey-auth'
 *   policyName: string,               // Default: 'apikey-auth'
 *   extAuthBackend: {
 *     name: string,                   // Default: 'ext-auth-service-enterprise-agentgateway'
 *     port: number,                   // Default: 8083
 *   },
 *   targetRefs: Array<{
 *     group: string,
 *     kind: string,
 *     name: string,
 *   }>,
 * }
 */
export class ApiKeyAuthFeature extends Feature {
  // Depends on the ext-auth-service/AuthConfig (extauth.solo.io) subsystem, which has no OSS equivalent.
  static SUPPORTED_EDITIONS = ['enterprise'];

  constructor(name, config) {
    super(name, config);

    this.secretName = config.secretName || 'apikey';
    this.apiKey = config.apiKey || randomBytes(24).toString('base64url');
    this.headerName = config.headerName || 'x-ai-api-key';
    this.labelSelector = config.labelSelector || { provider: 'openai' };

    this.authConfigName = config.authConfigName || 'apikey-auth';
    this.policyName = config.policyName || 'apikey-auth';

    const extAuth = config.extAuthBackend || {};
    this.extAuthServiceName = extAuth.name || 'ext-auth-service-enterprise-agentgateway';
    this.extAuthServicePort = extAuth.port || 8083;

    this.targetRefs = config.targetRefs || null;
  }

  getFeaturePath() {
    return 'apikey-auth';
  }

  validate() {
    return true;
  }

  async deploy() {
    this.log('Configuring API key authentication...', 'info');

    await this.deployApiKeySecret();
    await this.deployAuthConfig();
    await this.deployExtAuthPolicy();

    this.log('API key authentication applied', 'success');
  }

  async deployApiKeySecret() {
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: this.secretName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
          ...this.labelSelector,
        },
      },
      type: 'extauth.solo.io/apikey',
      stringData: {
        'api-key': this.apiKey,
      },
    };

    await this.applyResource(secret);
    this.log(`API key secret '${this.secretName}' created`, 'info');
  }

  async deployAuthConfig() {
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
            apiKeyAuth: {
              headerName: this.headerName,
              labelSelector: this.labelSelector,
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
    this.log('Cleaning up API key authentication...', 'info');

    await this.deleteResource('EnterpriseAgentgatewayPolicy', this.policyName);
    await this.deleteResource('AuthConfig', this.authConfigName);
    await this.deleteResource('Secret', this.secretName);

    this.log('API key authentication cleaned up', 'success');
  }
}

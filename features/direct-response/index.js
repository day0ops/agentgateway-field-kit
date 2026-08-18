import { Feature, FeatureManager } from '../../src/lib/feature.js';

/**
 * Direct Response Feature
 *
 * Creates an HTTPRoute with no backend, plus an EnterpriseAgentgatewayPolicy
 * (spec.traffic.directResponse) targeting it. Useful for health checks and
 * other fixed responses that shouldn't hit a real backend.
 *
 * Configuration:
 * {
 *   routeName: string,      // HTTPRoute name (default: 'direct-response')
 *   pathPrefix: string,     // Route path prefix (default: '/direct-response')
 *   status: number,         // HTTP status code to return (default: 200)
 *   body: string,           // Response body (optional)
 *   headers: Array<{name: string, value: string}>, // Extra response headers (optional)
 * }
 */
export class DirectResponseFeature extends Feature {
  // spec.traffic.directResponse is an enterprise-only policy field, no OSS equivalent exists.
  static SUPPORTED_EDITIONS = ['enterprise'];

  constructor(name, config) {
    super(name, config);

    this.routeName = config.routeName || 'direct-response';
    this.pathPrefix = config.pathPrefix || '/direct-response';
    this.status = config.status ?? 200;
    this.body = config.body;
    this.headers = config.headers || null;
  }

  validate() {
    if (!this.pathPrefix) {
      throw new Error('direct-response requires pathPrefix in config');
    }
    if (typeof this.status !== 'number') {
      throw new Error('direct-response requires a numeric status in config');
    }
    return true;
  }

  get policyName() {
    return `${this.name}-${this.routeName}`;
  }

  async deploy() {
    const gatewayRef = FeatureManager.getGatewayRef();

    const route = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        parentRefs: [
          {
            name: gatewayRef.name,
            namespace: gatewayRef.namespace,
          },
        ],
        rules: [
          {
            matches: [
              {
                path: { type: 'PathPrefix', value: this.pathPrefix },
              },
            ],
          },
        ],
      },
    };

    await this.applyResource(route);
    this.log(`HTTPRoute '${this.routeName}' created at ${this.pathPrefix}`, 'info');

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
        targetRefs: [
          {
            group: 'gateway.networking.k8s.io',
            kind: 'HTTPRoute',
            name: this.routeName,
          },
        ],
        traffic: {
          directResponse: {
            status: this.status,
            ...(this.body !== undefined && { body: this.body }),
            ...(this.headers && { headers: this.headers }),
          },
        },
      },
    };

    await this.applyResource(policy);
    this.log(
      `Direct response policy applied to '${this.routeName}' (status ${this.status})`,
      'info'
    );
  }

  async cleanup() {
    this.log('Cleaning up direct-response feature...', 'info');
    await this.deleteResource('EnterpriseAgentgatewayPolicy', this.policyName);
    await this.deleteResource('HTTPRoute', this.routeName);
    this.log('direct-response feature cleaned up', 'info');
  }
}

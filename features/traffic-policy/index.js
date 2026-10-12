import { Feature } from '../../src/lib/feature.js';

/**
 * Traffic Policy Feature
 *
 * Applies an EnterpriseAgentgatewayPolicy (spec.traffic.timeouts/retry/headerModifiers)
 * to an existing HTTPRoute (or other targetRef) created by another feature - e.g. a
 * mock-provider or providers route. Kept separate from those features so any
 * route can pick up this behavior without coupling to how the route itself was created.
 *
 * Configuration:
 * {
 *   targetRef: {
 *     name: string,      // Name of the resource to target (required)
 *     kind: string,      // Target resource kind (default: 'HTTPRoute')
 *     group: string,     // Target resource API group (default: 'gateway.networking.k8s.io')
 *   },
 *   timeouts: {
 *     request: string,   // e.g. '1ms', '2s' (optional)
 *   },
 *   retry: {
 *     attempts: number,  // Max retry attempts (optional)
 *     backoff: string,   // e.g. '25ms' (optional)
 *     codes: number[],   // HTTP status codes that trigger a retry, e.g. [503] (optional)
 *   },
 *   headerModifiers: {   // Literal header add/set/remove, applied before the request/response
 *     request: {         // leaves the gateway - e.g. stripping Sec-WebSocket-Extensions so
 *       add: [{ name, value }],    // permessage-deflate never negotiates on a WebSocket upgrade.
 *       set: [{ name, value }],
 *       remove: [string],
 *     },
 *     response: {
 *       add: [{ name, value }],
 *       set: [{ name, value }],
 *       remove: [string],
 *     },
 *   },
 * }
 */
export class TrafficPolicyFeature extends Feature {
  // spec.traffic.timeouts/retry/headerModifiers are enterprise-only policy fields, no OSS equivalent exists.
  static SUPPORTED_EDITIONS = ['enterprise'];

  constructor(name, config) {
    super(name, config);

    this.targetRef = config.targetRef || {};
    this.timeouts = config.timeouts || null;
    this.retry = config.retry || null;
    this.headerModifiers = config.headerModifiers || null;
  }

  validate() {
    if (!this.targetRef.name) {
      throw new Error('traffic-policy requires targetRef.name in config');
    }
    if (!this.timeouts && !this.retry && !this.headerModifiers) {
      throw new Error(
        'traffic-policy requires at least one of timeouts, retry, or headerModifiers in config'
      );
    }
    return true;
  }

  get policyName() {
    return `${this.name}-${this.targetRef.name}`;
  }

  async deploy() {
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
            group: this.targetRef.group || 'gateway.networking.k8s.io',
            kind: this.targetRef.kind || 'HTTPRoute',
            name: this.targetRef.name,
          },
        ],
        traffic: {
          ...(this.timeouts && { timeouts: this.timeouts }),
          ...(this.retry && { retry: this.retry }),
          ...(this.headerModifiers && { headerModifiers: this.headerModifiers }),
        },
      },
    };

    await this.applyResource(policy);
    this.log(`Traffic policy applied to '${this.targetRef.name}'`, 'info');
  }

  async cleanup() {
    this.log('Cleaning up traffic-policy feature...', 'info');
    await this.deleteResource('EnterpriseAgentgatewayPolicy', this.policyName);
    this.log('traffic-policy feature cleaned up', 'info');
  }
}

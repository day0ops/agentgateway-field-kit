import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { policyApiVersion, POLICY_KIND } from '../../src/lib/editions.js';

/**
 * Virtual Keys Feature
 *
 * Issues API keys, stored as JSON entries in a Kubernetes Secret, and authenticates
 * requests against them.
 *
 * Enterprise: also enforces a per-key token budget. Both API key authentication and
 * rate limiting are applied via a SINGLE EnterpriseAgentgatewayPolicy object. When two
 * policies target the same Gateway, one silently overwrites the other based on creation
 * order (even though both report ACCEPTED/ATTACHED status), so this must never be split
 * into two policy objects. Rate limiting uses the enterprise chart's built-in rate-limit
 * service via a RateLimitConfig CRD - no backend Service to deploy.
 *
 * Opensource: emits apiKeyAuthentication only. tokenBudget is accepted (for config-shape
 * parity with enterprise) but not enforced here - OSS merges policies field-by-field, not
 * deep-merged, so a second policy also setting traffic.rateLimit on the same attachment
 * point would silently collide with this one's. Enforce opensource per-key budgets with a
 * separate rate-limit feature instance's `conditional` config, keyed on apiKey.user_id,
 * targeting the same attachment point as this feature.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/llm/cost-controls/virtual-keys/
 *
 * Configuration:
 * {
 *   keys: [
 *     {
 *       name: string,        // Key identifier (used as Secret data key)
 *       key: string,         // The actual API key value (e.g. "sk-alice-abc123")
 *       userId: string,      // User ID - stored as both metadata.id (native virtualKey budget
 *                            // subject dimension, apiKey.id) and metadata.user_id (this
 *                            // feature's own rate-limit CEL action)
 *       tokenBudget: number, // Token limit per hour
 *     }
 *   ],
 *   policyName: string,          // Default: 'virtual-keys'
 *   rateLimitConfigName: string, // Default: 'virtual-keys-ratelimit'
 *   targetRefs: [            // Routes to protect (defaults to Gateway-wide)
 *     { group: string, kind: string, name: string }
 *   ],
 *   mode: string,            // apiKeyAuthentication.mode: 'Strict' (default, unchanged) |
 *                            // 'Optional' | 'Permissive'. Use 'Optional' to let a route also
 *                            // accept a different auth method (e.g. JWT) for other callers -
 *                            // Strict here would reject any request missing an API key even
 *                            // if it already authenticated another way.
 *   location: {              // Where to read the key from. Default: Authorization: Bearer
 *                            // header (unchanged) - matches this feature's original behavior.
 *                            // Set this when sharing a route with jwtAuthentication, which
 *                            // also reads Authorization by default and would otherwise try
 *                            // (and fail) to parse an API key as a JWT.
 *     header: { name: string, prefix?: string } |
 *     queryParameter: { name: string } |
 *     cookie: { name: string },
 *   },
 * }
 */
export class VirtualKeysFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.policyName = config.policyName || 'virtual-keys';
    this.rateLimitConfigName = config.rateLimitConfigName || 'virtual-keys-ratelimit';
    this.mode = config.mode || 'Strict';
    this.location = config.location || null;
  }

  validate() {
    if (!this.config.keys || this.config.keys.length === 0) {
      throw new Error('virtual-keys: at least one key is required');
    }
    for (const k of this.config.keys) {
      if (!k.name) throw new Error('virtual-keys: each key must have a name');
      if (!k.key) throw new Error('virtual-keys: each key must have a key value');
      if (!k.userId) throw new Error('virtual-keys: each key must have a userId');
    }
    return true;
  }

  get targetRefs() {
    if (this.config.targetRefs) return this.config.targetRefs;
    const gatewayRef = FeatureManager.getGatewayRef();
    return [
      {
        group: 'gateway.networking.k8s.io',
        kind: 'Gateway',
        name: gatewayRef.name,
      },
    ];
  }

  async deploy() {
    this.log('Deploying virtual keys...', 'info');

    await this._deploySecret();
    if (this.edition === 'opensource') {
      await this._deployOpensourcePolicy();
    } else {
      await this._deployRateLimitConfig();
      await this._deployPolicy();
    }

    this.log('Virtual keys deployed', 'success');
  }

  async _deployOpensourcePolicy() {
    const apiKeyAuthentication = {
      mode: this.mode,
      secretRef: { name: 'virtual-keys' },
    };
    if (this.location) apiKeyAuthentication.location = this.location;

    const policy = {
      apiVersion: policyApiVersion(this.edition),
      kind: POLICY_KIND[this.edition],
      metadata: {
        name: this.policyName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': 'virtual-keys',
        },
      },
      spec: {
        targetRefs: this.targetRefs,
        traffic: { apiKeyAuthentication },
      },
    };

    await this.applyResource(policy);
    this.log(
      `${POLICY_KIND[this.edition]} '${this.policyName}' applied (apiKeyAuthentication only)`,
      'info'
    );
  }

  async _deploySecret() {
    const stringData = {};
    for (const k of this.config.keys) {
      stringData[k.name] = JSON.stringify({
        key: k.key,
        // `id` is what the shipped default budget dimension config resolves the native
        // `virtualKey` subject from (attributes: [{ id: 'virtualKey', expression: 'apiKey.id' }]
        // in the enterprise-agentgateway chart's values.yaml) - metadata is a fully arbitrary
        // JSON object flattened onto the `apiKey` CEL namespace (UserMetadata =
        // serde_json::Value in the enterprise proxy), so `apiKey.id` only resolves if this
        // field is literally named `id`. The Secret's own data-key name (e.g. "team-ci") is
        // never used for this - it's only a lookup key, discarded after key-hash matching.
        // `user_id` is kept alongside it since this feature's own rate-limit CEL action
        // (apiKey.user_id, below) still reads that name.
        metadata: { id: k.userId, user_id: k.userId },
      });
    }

    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'virtual-keys',
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': 'virtual-keys',
        },
      },
      type: 'Opaque',
      stringData,
    };

    await this.applyResource(secret);
    this.log(`Virtual keys Secret created with ${this.config.keys.length} key(s)`, 'info');
  }

  async _deployRateLimitConfig() {
    // One descriptor per key: the CEL action below extracts user_id from the matched
    // API key's metadata, and the rate limit service matches it against these entries.
    const descriptors = this.config.keys.map(k => ({
      key: 'user_id',
      value: k.userId,
      rateLimit: {
        unit: 'HOUR',
        requestsPerUnit: k.tokenBudget,
      },
    }));

    const rateLimitConfig = {
      apiVersion: 'ratelimit.solo.io/v1alpha1',
      kind: 'RateLimitConfig',
      metadata: {
        name: this.rateLimitConfigName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': 'virtual-keys',
        },
      },
      spec: {
        raw: {
          descriptors,
          rateLimits: [
            {
              actions: [{ cel: { expression: 'apiKey.user_id', key: 'user_id' } }],
              type: 'TOKEN',
            },
          ],
        },
      },
    };

    await this.applyResource(rateLimitConfig);
    this.log(
      `RateLimitConfig '${this.rateLimitConfigName}' applied with ${descriptors.length} descriptor(s)`,
      'info'
    );
  }

  async _deployPolicy() {
    const apiKeyAuthentication = {
      mode: this.mode,
      secretRef: { name: 'virtual-keys' },
    };
    if (this.location) apiKeyAuthentication.location = this.location;

    const policy = {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: {
        name: this.policyName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': 'virtual-keys',
        },
      },
      spec: {
        targetRefs: this.targetRefs,
        traffic: {
          apiKeyAuthentication,
          entRateLimit: {
            global: {
              rateLimitConfigRefs: [{ name: this.rateLimitConfigName }],
            },
          },
        },
      },
    };

    await this.applyResource(policy);
    this.log(
      `EnterpriseAgentgatewayPolicy '${this.policyName}' applied (apiKeyAuthentication + entRateLimit)`,
      'info'
    );
  }

  async cleanup() {
    await this.deleteResource(POLICY_KIND[this.edition], this.policyName);
    if (this.edition !== 'opensource') {
      await this.deleteResource('RateLimitConfig', this.rateLimitConfigName);
    }
    await this.deleteResource('Secret', 'virtual-keys');

    // Best-effort cleanup of the pre-upgrade two-policy names, so re-running cleanup
    // after upgrading to the merged single-policy version doesn't orphan old resources.
    await this.deleteResource('EnterpriseAgentgatewayPolicy', 'virtual-keys-auth');
    await this.deleteResource('EnterpriseAgentgatewayPolicy', 'virtual-keys-ratelimit');
  }
}

export function createVirtualKeysFeature(config) {
  return new VirtualKeysFeature('virtual-keys', config);
}

import { Feature, FeatureManager } from '../../src/lib/feature.js';

/**
 * Rate Limit Feature
 *
 * Implements rate limiting in two modes:
 *
 * 1. Global (default) — uses a central Rate Limit Server shared across all
 *    proxy replicas. Requires a RateLimitConfig CRD and an
 *    EnterpriseAgentgatewayPolicy with traffic.entRateLimit.global.
 *    Supports both REQUEST and TOKEN counting types.
 *
 * 2. Local — enforced per-replica on each proxy independently (no central
 *    server). Uses EnterpriseAgentgatewayPolicy with traffic.rateLimit.local.
 *    Counts input tokens per time window.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/security/rate-limit-http/
 *
 * Configuration:
 * {
 *   mode: string,                    // "global" (default) | "local"
 *   type: string,                    // Global only: "REQUEST" (default) | "TOKEN"
 *   name: string,                    // Resource name prefix (default: "rate-limit-config")
 *   requestsPerUnit: number,         // Global: max requests/tokens per unit (default: 5)
 *   unit: string,                    // Time unit: SECOND | MINUTE | HOUR | DAY (default: "MINUTE")
 *   descriptorKey: string,           // Global: descriptor key (default: "generic_key")
 *   descriptorValue: string,         // Global: descriptor value (default: "counter")
 *   tokens: number,                  // Local: token budget per window (default: 5)
 *   burst: number,                   // Local: burst allowance (default: 0)
 *   gatewayName: string,             // Target Gateway name (resolved from FeatureManager if omitted)
 *   targetRefs: Array<{              // Override what the policy targets (default: the Gateway).
 *     name: string,                   //   e.g. target a specific HTTPRoute to scope the limit to one route (like /mcp)
 *     group: string,                  //   default: 'gateway.networking.k8s.io'
 *     kind: string,                   //   'Gateway' | 'HTTPRoute'
 *   }>,
 * }
 */
export class RateLimitFeature extends Feature {
  // Enterprise-only quota/rate-limit management, confirmed no reusable OSS primitive exists.
  static SUPPORTED_EDITIONS = ['enterprise'];

  validate() {
    const { mode = 'global', requestsPerUnit, tokens } = this.config;
    if (
      mode === 'global' &&
      requestsPerUnit !== undefined &&
      (typeof requestsPerUnit !== 'number' || requestsPerUnit < 1)
    ) {
      throw new Error('requestsPerUnit must be a positive integer');
    }
    if (mode === 'local' && tokens !== undefined && (typeof tokens !== 'number' || tokens < 1)) {
      throw new Error('tokens must be a positive integer');
    }
    return true;
  }

  get mode() {
    return this.config.mode || 'global';
  }

  get rateLimitName() {
    return this.config.name || 'rate-limit-config';
  }

  get policyName() {
    return `${this.rateLimitName}-policy`;
  }

  get targetRefs() {
    if (this.config.targetRefs) {
      return this.config.targetRefs.map(ref => ({
        group: ref.group || 'gateway.networking.k8s.io',
        kind: ref.kind || 'Gateway',
        name: ref.name,
      }));
    }

    const gatewayRef = FeatureManager.getGatewayRef();
    const gatewayName = this.config.gatewayName || gatewayRef.name;
    return [
      {
        name: gatewayName,
        group: 'gateway.networking.k8s.io',
        kind: 'Gateway',
      },
    ];
  }

  async deploy() {
    if (this.mode === 'local') {
      await this.deployLocal();
    } else {
      await this.deployGlobal();
    }
  }

  async deployGlobal() {
    const {
      type = 'REQUEST',
      requestsPerUnit = 5,
      unit = 'MINUTE',
      descriptorKey = 'generic_key',
      descriptorValue = 'counter',
    } = this.config;

    const rlcOverrides = {
      metadata: { name: this.rateLimitName },
      spec: {
        raw: {
          descriptors: [
            {
              key: descriptorKey,
              value: descriptorValue,
              rateLimit: {
                requestsPerUnit,
                unit,
              },
            },
          ],
          rateLimits: [
            {
              actions: [{ genericKey: { descriptorValue } }],
              type,
            },
          ],
        },
      },
    };

    await this.applyYamlFile('rate-limit-config.yaml', rlcOverrides);

    const policyOverrides = {
      metadata: { name: this.policyName },
      spec: {
        targetRefs: this.targetRefs,
        traffic: {
          entRateLimit: {
            global: {
              rateLimitConfigRefs: [{ name: this.rateLimitName }],
            },
          },
        },
      },
    };

    await this.applyYamlFile('enterprise-agentgateway-policy.yaml', policyOverrides);
  }

  async deployLocal() {
    const { tokens = 5, burst = 0, unit = 'MINUTE' } = this.config;

    const unitMap = {
      SECOND: 'Seconds',
      MINUTE: 'Minutes',
      HOUR: 'Hours',
      DAY: 'Days',
    };

    const policyOverrides = {
      metadata: { name: this.policyName },
      spec: {
        targetRefs: this.targetRefs,
        traffic: {
          rateLimit: {
            local: [
              {
                unit: unitMap[unit] || 'Minutes',
                tokens,
                burst,
              },
            ],
          },
        },
      },
    };

    await this.applyYamlFile('local-rate-limit-policy.yaml', policyOverrides);
  }

  async cleanup() {
    await this.deleteResource('EnterpriseAgentgatewayPolicy', this.policyName);
    if (this.mode === 'global') {
      await this.deleteResource('RateLimitConfig', this.rateLimitName);
    }
  }
}

export function createRateLimitFeature(config) {
  return new RateLimitFeature('rate-limit', config);
}

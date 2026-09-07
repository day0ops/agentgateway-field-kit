import { Feature, FeatureManager } from '../../src/lib/feature.js';

/**
 * Rate Limit Feature
 *
 * Implements rate limiting in two modes:
 *
 * 1. Global (default) - uses a central Rate Limit Server shared across all
 *    proxy replicas. Requires a RateLimitConfig CRD and an
 *    EnterpriseAgentgatewayPolicy with traffic.entRateLimit.global.
 *    Supports both REQUEST and TOKEN counting types, or a set of per-tool
 *    CEL-based `descriptors` for MCP tool-name-scoped limits (REQUEST only).
 *
 * 2. Local - enforced per-replica on each proxy independently (no central
 *    server). Uses EnterpriseAgentgatewayPolicy with traffic.rateLimit.local.
 *    Counts input tokens per time window.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/security/rate-limit-http/
 * Reference (descriptors): https://docs.solo.io/agentgateway/kubernetes/latest/documentation/mcp/rate-limit/
 *
 * Configuration:
 * {
 *   mode: string,                    // "global" (default) | "local"
 *   type: string,                    // Global flat mode only: "REQUEST" (default) | "TOKEN"
 *   name: string,                    // Resource name prefix (default: "rate-limit-config")
 *   requestsPerUnit: number,         // Global flat mode: max requests/tokens per unit (default: 5)
 *   unit: string,                    // Time unit: SECOND | MINUTE | HOUR | DAY (default: "MINUTE")
 *   descriptorKey: string,           // Global flat mode: descriptor key (default: "generic_key")
 *   descriptorValue: string,         // Global flat mode: descriptor value (default: "counter")
 *   descriptors: Array<{             // Global only: per-tool CEL-based limits, replaces the flat
 *     match: {                       //   single-counter shape above when set. One entry per tool;
 *       method: string,                //   an entry with no `tool` is the catch-all default for
 *       tool: string,                  //   any tool name not otherwise listed. `method` currently
 *     },                              //   only supports 'tools/call' (validated).
 *     requestsPerUnit: number,
 *     unit: string,                  //   default: "MINUTE"
 *   }>,
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
    const { mode = 'global', requestsPerUnit, tokens, descriptors } = this.config;

    if (descriptors) {
      if (mode !== 'global') {
        throw new Error('descriptors-based rate limiting requires mode: "global"');
      }
      for (const d of descriptors) {
        const method = d.match?.method ?? 'tools/call';
        if (method !== 'tools/call') {
          throw new Error(
            `descriptors currently only support match.method: 'tools/call', got '${method}'`
          );
        }
        if (typeof d.requestsPerUnit !== 'number' || d.requestsPerUnit < 1) {
          throw new Error('each descriptors entry requires a positive integer requestsPerUnit');
        }
      }
    }

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

  /**
   * Builds the per-tool CEL descriptor tree + CEL actions for the `descriptors`
   * config. Mirrors the docs' example: a top-level mcp_method descriptor
   * (fixed to 'tools/call') nesting one tool_name entry per configured tool,
   * plus a catch-all entry (no `value`) for any tool not explicitly listed.
   */
  buildToolDescriptorsRaw(descriptors) {
    const toolDescriptors = descriptors.map(d => ({
      key: 'tool_name',
      ...(d.match?.tool !== undefined && { value: d.match.tool }),
      rateLimit: { requestsPerUnit: d.requestsPerUnit, unit: d.unit || 'MINUTE' },
    }));

    return {
      descriptors: [{ key: 'mcp_method', value: 'tools/call', descriptors: toolDescriptors }],
      rateLimits: [
        {
          actions: [
            {
              cel: {
                expression:
                  'json(request.body).with(body, body.method == "tools/call" ? "tools/call" : "other")',
                key: 'mcp_method',
              },
            },
            {
              cel: {
                expression:
                  'json(request.body).with(body, body.method == "tools/call" ? string(body.params.name) : "none")',
                key: 'tool_name',
              },
            },
          ],
          type: 'REQUEST',
        },
      ],
    };
  }

  async deployGlobal() {
    const {
      type = 'REQUEST',
      requestsPerUnit = 5,
      unit = 'MINUTE',
      descriptorKey = 'generic_key',
      descriptorValue = 'counter',
      descriptors,
    } = this.config;

    const raw = descriptors
      ? this.buildToolDescriptorsRaw(descriptors)
      : {
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
        };

    const rlcOverrides = {
      metadata: { name: this.rateLimitName },
      spec: { raw },
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

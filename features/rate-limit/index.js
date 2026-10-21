import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { policyApiVersion, POLICY_KIND } from '../../src/lib/editions.js';

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
 *   key: string,                     // Local: CEL expression selecting the bucket a request
 *                                    //   counts against, e.g. 'jwt.sub' for a per-user limit
 *   rules: Array<{                   // Local: stack multiple flat rules on one policy.
 *     requests: number,              //   Mutually exclusive with the flat tokens/burst/key
 *     tokens: number,                //   fields above and with `conditional` below.
 *     unit: string,
 *     burst: number,
 *     key: string,
 *   }>,
 *   conditional: Array<{             // Local: CEL-branching rules, mirroring the CRD's own
 *     condition: string,             //   conditional[] shape. A branch with no `condition` is
 *     rules: Array<{                 //   the fallback. Mutually exclusive with `rules` above -
 *       requests: number,            //   when set, this entirely replaces the policy's flat
 *       tokens: number,              //   local rules (the CRD does not combine them).
 *       unit: string,
 *       burst: number,
 *       key: string,
 *     }>,
 *   }>,
 *   gatewayName: string,             // Target Gateway name (resolved from FeatureManager if omitted)
 *   targetRefs: Array<{              // Override what the policy targets (default: the Gateway).
 *     name: string,                   //   e.g. target a specific HTTPRoute to scope the limit to one route (like /mcp)
 *     group: string,                  //   default: 'gateway.networking.k8s.io'
 *     kind: string,                   //   'Gateway' | 'HTTPRoute'
 *   }>,
 * }
 */
export class RateLimitFeature extends Feature {
  validate() {
    const {
      mode = 'global',
      requestsPerUnit,
      tokens,
      descriptors,
      rules,
      conditional,
    } = this.config;

    if (this.edition === 'opensource' && mode === 'global') {
      throw new Error(
        'rate-limit: opensource global rate limiting requires a self-hosted Envoy ratelimit ' +
          'service and is not yet wired up by this CLI; use mode: "local" instead'
      );
    }

    if (rules && conditional) {
      throw new Error('rate-limit: rules and conditional are mutually exclusive');
    }

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

  static UNIT_MAP = { SECOND: 'Seconds', MINUTE: 'Minutes', HOUR: 'Hours', DAY: 'Days' };

  // A single resolved local rule: {unit, tokens|requests, burst?, key?}. `defaultUnit` is the
  // rule's own `unit` if set, else the config-level `unit` (default 'MINUTE').
  resolveLocalRule(rule, defaultUnit) {
    const resolved = {
      unit: RateLimitFeature.UNIT_MAP[rule.unit || defaultUnit] || 'Minutes',
    };
    if (rule.requests !== undefined) {
      resolved.requests = rule.requests;
    } else {
      resolved.tokens = rule.tokens ?? 5;
    }
    if (rule.burst !== undefined) resolved.burst = rule.burst;
    if (rule.key !== undefined) resolved.key = rule.key;
    return resolved;
  }

  async deployLocal() {
    const { unit = 'MINUTE', tokens = 5, burst = 0, key, rules, conditional } = this.config;

    const policyOverrides = {
      metadata: { name: this.policyName },
      spec: { targetRefs: this.targetRefs, traffic: { rateLimit: {} } },
    };

    if (conditional) {
      policyOverrides.spec.traffic.rateLimit.conditional = conditional.map(branch => {
        const entry = {
          policy: { local: branch.rules.map(r => this.resolveLocalRule(r, unit)) },
        };
        if (branch.condition !== undefined) entry.condition = branch.condition;
        return entry;
      });
      // conditional replaces the template's default local rule entirely (the CRD's own
      // semantics: a policy's conditional branches are exclusive with its top-level local,
      // not combined with it) - explicit undefined makes deepMerge delete the inherited key.
      policyOverrides.spec.traffic.rateLimit.local = undefined;
    } else if (rules) {
      policyOverrides.spec.traffic.rateLimit.local = rules.map(r => this.resolveLocalRule(r, unit));
    } else {
      policyOverrides.spec.traffic.rateLimit.local = [
        {
          unit: RateLimitFeature.UNIT_MAP[unit] || 'Minutes',
          tokens,
          burst,
          ...(key !== undefined && { key }),
        },
      ];
    }

    if (this.edition === 'opensource') {
      policyOverrides.apiVersion = policyApiVersion(this.edition);
      policyOverrides.kind = POLICY_KIND[this.edition];
    }

    await this.applyYamlFile('local-rate-limit-policy.yaml', policyOverrides);
  }

  async cleanup() {
    await this.deleteResource(POLICY_KIND[this.edition], this.policyName);
    if (this.mode === 'global' && this.edition !== 'opensource') {
      await this.deleteResource('RateLimitConfig', this.rateLimitName);
    }
  }
}

export function createRateLimitFeature(config) {
  return new RateLimitFeature('rate-limit', config);
}

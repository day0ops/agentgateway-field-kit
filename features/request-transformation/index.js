import { Feature } from '../../src/lib/feature.js';
import { policyApiVersion, POLICY_KIND } from '../../src/lib/editions.js';

/**
 * Request Transformation Feature
 *
 * Dynamically computes LLM request fields using CEL expressions before forwarding.
 * Each transformation specifies a field name and a CEL expression. The computed
 * value replaces the field in the outgoing request. Failed expressions silently
 * drop the field. Max 64 transformations per policy.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/llm/transformations/
 *
 * Configuration:
 * {
 *   transformations: [
 *     {
 *       field: string,       // LLM request field name (e.g. "max_completion_tokens")
 *       expression: string,  // CEL expression (e.g. "min(int(llmRequest.max_completion_tokens), 500)")
 *     }
 *   ],
 *   targetRefs: [            // Routes to apply to (auto-injected from providers)
 *     { group: string, kind: string, name: string }
 *   ]
 * }
 *
 * CEL context: `llmRequest` = incoming request body parsed as object.
 * Example expressions:
 *   - Cap tokens:    "has(llmRequest.max_completion_tokens) ? min(int(llmRequest.max_completion_tokens), 500) : 500"
 *   - Force effort:  '"low"'  (hardcoded string)
 *   - From header:   'request.headers["x-max-tokens"]'
 */
export class RequestTransformationFeature extends Feature {
  validate() {
    if (!this.config.transformations || this.config.transformations.length === 0) {
      throw new Error('request-transformation: at least one transformation is required');
    }
    if (this.config.transformations.length > 64) {
      throw new Error('request-transformation: max 64 transformations per policy');
    }
    for (const t of this.config.transformations) {
      if (!t.field)
        throw new Error('request-transformation: each transformation must have a field');
      if (!t.expression)
        throw new Error('request-transformation: each transformation must have an expression');
    }
    return true;
  }

  async deploy() {
    const { transformations, targetRefs = null } = this.config;

    const policyOverrides = {
      apiVersion: policyApiVersion(this.edition),
      kind: POLICY_KIND[this.edition],
      metadata: {
        name: 'request-transformation',
        namespace: this.namespace,
        labels: { 'agentgateway.dev/feature': 'request-transformation' },
      },
      spec: {
        backend: {
          ai: { transformations },
        },
      },
    };

    if (targetRefs) {
      policyOverrides.spec.targetRefs = targetRefs;
    }

    await this.applyYamlFile('traffic-policy.yaml', policyOverrides);
    this.log(
      `Request transformation policy applied (${transformations.length} transformation(s))`,
      'success'
    );
  }

  async cleanup() {
    await this.deleteResource(POLICY_KIND[this.edition], 'request-transformation');
  }
}

export function createRequestTransformationFeature(config) {
  return new RequestTransformationFeature('request-transformation', config);
}

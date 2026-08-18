import { Feature } from '../../src/lib/feature.js';
import { Logger } from '../../src/lib/common.js';
import { policyApiVersion, POLICY_KIND } from '../../src/lib/editions.js';

/**
 * Prompt Enrichment Feature
 *
 * Enriches LLM prompts by prepending or appending messages using the
 * EnterpriseAgentgatewayPolicy API (spec.backend.ai.prompt).
 *
 * Reference: https://docs.solo.io/agentgateway/latest/llm/prompt-enrichment/
 * API Reference: https://docs.solo.io/agentgateway/latest/reference/api/solo/
 *
 * This feature:
 * - Prepends system prompts/instructions to all requests
 * - Appends additional context or guidelines
 * - Separates system prompts from user prompts for centralized management
 * - Targets HTTPRoute resources created by the providers feature
 *
 * Providers dependency:
 * When used alongside the providers feature, targetRefs are automatically
 * injected to point at each provider's HTTPRoute. Without providers, you must
 * supply targetRefs explicitly so the policy knows which routes to attach to.
 * See: features/providers/index.js
 *
 * Configuration:
 * {
 *   prepend: [
 *     { role: "SYSTEM"|"USER", content: string }
 *   ],
 *   append: [
 *     { role: "SYSTEM"|"USER", content: string }
 *   ],
 *   targetRefs: [              // Auto-injected from providers feature; or set manually
 *     { group: "gateway.networking.k8s.io", kind: "HTTPRoute", name: string }
 *   ]
 * }
 *
 * Example:
 * {
 *   prepend: [
 *     { role: "SYSTEM", content: "You are a helpful customer service assistant." },
 *     { role: "SYSTEM", content: "Always be polite and professional." }
 *   ],
 *   append: [
 *     { role: "SYSTEM", content: "Always ask for feedback at the end." }
 *   ]
 * }
 *
 * Note on Anthropic: Anthropic does not support SYSTEM role messages the same
 * way. Use the `defaults` setting on the backend to set the system field instead.
 * See: https://docs.solo.io/agentgateway/latest/reference/api/api/
 */
export class PromptEnrichmentFeature extends Feature {
  validate() {
    return true;
  }

  async deploy() {
    const { prepend = [], append = [], targetRefs = null } = this.config;

    const policyOverrides = {
      apiVersion: policyApiVersion(this.edition),
      kind: POLICY_KIND[this.edition],
      spec: {
        backend: {
          ai: {
            prompt: {},
          },
        },
      },
    };

    if (targetRefs) {
      policyOverrides.spec.targetRefs = targetRefs;
    }

    if (prepend.length > 0) {
      policyOverrides.spec.backend.ai.prompt.prepend = prepend.map(msg => ({
        role: msg.role.toLowerCase(),
        content: msg.content,
      }));
    }

    if (append.length > 0) {
      policyOverrides.spec.backend.ai.prompt.append = append.map(msg => ({
        role: msg.role.toLowerCase(),
        content: msg.content,
      }));
    }

    await this.applyYamlFile('traffic-policy.yaml', policyOverrides);
  }

  async cleanup() {
    await this.deleteResource(POLICY_KIND[this.edition], 'prompt-enrichment');
  }
}

// Export a factory function for easy instantiation
export function createPromptEnrichmentFeature(config) {
  return new PromptEnrichmentFeature('prompt-enrichment', config);
}

import { Feature } from '../../src/lib/feature.js';
import { Logger, KubernetesHelper } from '../../src/lib/common.js';
import { policyApiVersion, POLICY_KIND } from '../../src/lib/editions.js';

/**
 * Prompt Guards Feature
 *
 * Implements request and response guardrails for LLM interactions using the
 * EnterpriseAgentgatewayPolicy API (spec.backend.ai.promptGuard).
 *
 * Reference: https://docs.solo.io/agentgateway/latest/llm/guardrails/overview/
 * API Reference: https://docs.solo.io/agentgateway/latest/reference/api/api/
 * Enterprise API: https://docs.solo.io/agentgateway/latest/reference/api/solo/
 *
 * This feature:
 * - Rejects unwanted requests with custom regex patterns or built-in PII detectors
 * - Moderates content using OpenAI's moderation API
 * - Masks sensitive data in LLM responses
 * - Targets HTTPRoute resources created by the providers feature
 * - Uses built-in patterns: CreditCard, Ssn, Email, PhoneNumber, CaSin
 *
 * For webhook-based guardrails, see the guardrail-webhook feature.
 *
 * Providers dependency:
 * When used alongside the providers feature, targetRefs are automatically
 * injected to point at each provider's HTTPRoute. Without providers, you must
 * supply targetRefs explicitly so the policy knows which routes to attach to.
 * See: features/providers/index.js
 *
 * Enterprise API structure:
 * promptGuard.request and promptGuard.response are arrays (max 8 entries each).
 * Each request entry uses ExactlyOneOf: regex, webhook, or openAIModeration.
 * Each response entry uses ExactlyOneOf: regex or webhook.
 *
 * Configuration:
 * {
 *   request: {
 *     customResponse: { message: string, statusCode: number },
 *     matches: string[],                // Custom regex patterns
 *     builtins: string[],               // Built-in: CreditCard, Ssn, Email, PhoneNumber, CaSin
 *     moderation: {
 *       openAIModeration: {
 *         model: string                 // e.g., "omni-moderation-latest"
 *       }
 *     }
 *   },
 *   response: {
 *     builtins: string[]                // Built-in patterns to mask in responses
 *   },
 *   targetRefs: [                       // Auto-injected from providers feature; or set manually
 *     { group: "gateway.networking.k8s.io", kind: "HTTPRoute", name: string }
 *   ]
 * }
 */
export class PromptGuardsFeature extends Feature {
  validate() {
    return true;
  }

  async deploy() {
    const { request = {}, response = {}, targetRefs = null } = this.config;

    const usesModerationAPI = request.moderation?.openAIModeration;
    if (usesModerationAPI) {
      await this.ensureOpenAISecret();
    }

    const policyOverrides = {
      apiVersion: policyApiVersion(this.edition),
      kind: POLICY_KIND[this.edition],
      spec: {
        backend: {
          ai: {
            promptGuard: {},
          },
        },
      },
    };

    if (targetRefs) {
      policyOverrides.spec.targetRefs = targetRefs;
    }

    // Build request guard entries (array, each with ExactlyOneOf: regex | webhook | openAIModeration)
    if (request.matches || request.builtins || request.moderation) {
      const requestGuards = [];

      if (request.matches || request.builtins) {
        const regexGuard = {
          regex: {
            action: 'Reject',
          },
        };

        if (request.matches && request.matches.length > 0) {
          regexGuard.regex.matches = request.matches.map(m =>
            typeof m === 'string' ? m : m.pattern
          );
        }

        if (request.builtins && request.builtins.length > 0) {
          regexGuard.regex.builtins = request.builtins;
        }

        if (request.customResponse?.message) {
          regexGuard.response = { message: request.customResponse.message };
          if (request.customResponse.statusCode) {
            regexGuard.response.statusCode = request.customResponse.statusCode;
          }
        }

        requestGuards.push(regexGuard);
      }

      if (request.moderation?.openAIModeration) {
        const moderationGuard = {
          openAIModeration: {
            policies: {
              auth: {
                secretRef: { name: 'openai-secret' },
              },
            },
          },
        };

        if (request.moderation.openAIModeration.model) {
          moderationGuard.openAIModeration.model = request.moderation.openAIModeration.model;
        }

        if (request.customResponse?.message && !request.matches && !request.builtins) {
          moderationGuard.response = { message: request.customResponse.message };
          if (request.customResponse.statusCode) {
            moderationGuard.response.statusCode = request.customResponse.statusCode;
          }
        }

        requestGuards.push(moderationGuard);
      }

      if (requestGuards.length > 0) {
        policyOverrides.spec.backend.ai.promptGuard.request = requestGuards;
      }
    }

    // Build response guard entries (array, each with ExactlyOneOf: regex | webhook)
    if (response.builtins && response.builtins.length > 0) {
      policyOverrides.spec.backend.ai.promptGuard.response = [
        {
          regex: {
            action: 'Mask',
            builtins: response.builtins,
          },
        },
      ];
    }

    await this.applyYamlFile('traffic-policy.yaml', policyOverrides);
  }

  async ensureOpenAISecret() {
    const secretName = 'openai-secret';
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error(
        `OPENAI_API_KEY environment variable is required for OpenAI moderation.\n\n` +
          `Please set it before deploying:\n` +
          `  export OPENAI_API_KEY="your-api-key"`
      );
    }

    const secretExists = await KubernetesHelper.resourceExists(
      'secret',
      secretName,
      this.namespace
    );

    if (!secretExists) {
      const bearerToken = `Bearer ${apiKey}`;

      await KubernetesHelper.createSecretFromLiteral(
        this.namespace,
        secretName,
        'Authorization',
        bearerToken,
        this.spinner
      );
      this.log(`Created ${secretName} for OpenAI moderation`, 'info');
    } else {
      this.log(`Using existing ${secretName}`, 'info');
    }
  }

  async cleanup() {
    await this.deleteResource(POLICY_KIND[this.edition], 'prompt-guards');
  }
}

// Export a factory function for easy instantiation
export function createPromptGuardsFeature(config) {
  return new PromptGuardsFeature('prompt-guards', config);
}

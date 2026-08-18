import { Feature } from '../../src/lib/feature.js';
import { policyApiVersion, POLICY_KIND } from '../../src/lib/editions.js';

/**
 * Prompt Templates Feature
 *
 * Dynamically transforms LLM request bodies using CEL expressions at the gateway.
 * Unlike prompt-enrichment (static prepend/append), this uses full CEL to compute
 * any field — including injecting request headers, JWT claims, or derived values
 * into the message body.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/llm/prompt-templates/
 *
 * Configuration:
 * {
 *   celExpression: string,   // CEL expression that transforms request.body → new JSON body
 *   targetRefs: [            // Routes to apply to (auto-injected from providers)
 *     { group: string, kind: string, name: string }
 *   ]
 * }
 *
 * Example celExpression (inject X-User-ID header as system message):
 *   toJson(json(request.body).with(body, {
 *     "messages": [{"role": "system", "content": "You are assisting user: " + request.headers["x-user-id"]}]
 *                  + body.messages
 *   }))
 * Note: call toJson(x) as a free function, not x.toJson() - the method-chain form fails
 * with "EOF while parsing a value" on this agentgateway build even though docs.solo.io's
 * own examples show it chained (confirmed live: json(request.body).toJson() alone fails
 * the same way, while toJson(json(request.body)) round-trips fine).
 */
export class PromptTemplatesFeature extends Feature {
  validate() {
    if (!this.config.celExpression) {
      throw new Error('prompt-templates: celExpression is required');
    }
    return true;
  }

  async deploy() {
    const { celExpression, targetRefs = null } = this.config;

    const policyOverrides = {
      apiVersion: policyApiVersion(this.edition),
      kind: POLICY_KIND[this.edition],
      metadata: {
        name: 'prompt-templates',
        namespace: this.namespace,
        labels: { 'agentgateway.dev/feature': 'prompt-templates' },
      },
      spec: {
        traffic: {
          transformation: {
            request: { body: celExpression },
          },
        },
      },
    };

    if (targetRefs) {
      policyOverrides.spec.targetRefs = targetRefs;
    }

    await this.applyYamlFile('traffic-policy.yaml', policyOverrides);
    this.log('Prompt template policy applied', 'success');
  }

  async cleanup() {
    await this.deleteResource(POLICY_KIND[this.edition], 'prompt-templates');
  }
}

export function createPromptTemplatesFeature(config) {
  return new PromptTemplatesFeature('prompt-templates', config);
}

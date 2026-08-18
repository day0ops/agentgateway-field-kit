import { Feature } from '../../src/lib/feature.js';
import { policyApiVersion, POLICY_KIND } from '../../src/lib/editions.js';

/**
 * CEL-Based RBAC Feature
 *
 * Controls access to LLM routes using CEL expressions evaluated per request.
 * Expressions can reference request headers, JWT claims, and other request context.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/llm/rbac/
 *
 * Configuration:
 * {
 *   action: 'Allow' | 'Deny',   // Whether matching requests are allowed or denied
 *   expressions: string[],       // CEL expressions (all must be true for action to apply)
 *   targetRefs: [                // Routes to protect (auto-injected from providers)
 *     { group: string, kind: string, name: string }
 *   ]
 * }
 *
 * CEL context: `request.headers`, JWT claims via `token.*`.
 * Example expressions:
 *   - Header check:   "request.headers['x-tier'] == 'premium'"
 *   - JWT claim:      "token.claims['role'] == 'admin'"
 *   - Combined:       "request.headers['x-org'] in ['acme', 'corp']"
 */
export class CelBasedRbacFeature extends Feature {
  validate() {
    if (!['Allow', 'Deny'].includes(this.config.action)) {
      throw new Error("cel-based-rbac: action must be 'Allow' or 'Deny'");
    }
    if (!this.config.expressions || this.config.expressions.length === 0) {
      throw new Error('cel-based-rbac: at least one expression is required');
    }
    return true;
  }

  async deploy() {
    const { action, expressions, targetRefs = null } = this.config;

    // OSS's traffic.authorization CRD field is byte-identical to enterprise's
    // (action + policy.matchExpressions) - only the CRD group/kind differs.
    const policyOverrides = {
      apiVersion: policyApiVersion(this.edition),
      kind: POLICY_KIND[this.edition],
      metadata: {
        name: 'cel-based-rbac',
        namespace: this.namespace,
        labels: { 'agentgateway.dev/feature': 'cel-based-rbac' },
      },
      spec: {
        traffic: {
          authorization: {
            action,
            policy: { matchExpressions: expressions },
          },
        },
      },
    };

    if (targetRefs) {
      policyOverrides.spec.targetRefs = targetRefs;
    }

    await this.applyYamlFile('traffic-policy.yaml', policyOverrides);
    this.log(
      `CEL RBAC policy applied (action=${action}, ${expressions.length} expression(s))`,
      'success'
    );
  }

  async cleanup() {
    await this.deleteResource(POLICY_KIND[this.edition], 'cel-based-rbac');
  }
}

export function createCelBasedRbacFeature(config) {
  return new CelBasedRbacFeature('cel-based-rbac', config);
}

import { Feature } from '../../src/lib/feature.js';
import {
  policyApiVersion,
  POLICY_KIND,
  BACKEND_API_GROUP,
  BACKEND_KIND,
} from '../../src/lib/editions.js';

/**
 * MCP Tool Access Feature
 *
 * Applies CEL-based RBAC to an MCP backend so only certain tools are visible/callable
 * for given JWT claims. Requires the backend to already have JWT/MCP auth (e.g. mcp-auth).
 *
 * Reference: https://agentgateway.dev/docs/kubernetes/latest/mcp/tool-access/
 *
 * Creates a policy targeting the mcp-server feature's backend
 * (EnterpriseAgentgatewayBackend on enterprise, AgentgatewayBackend on opensource) with
 * spec.backend.mcp.authorization (action: Allow, policy.matchExpressions) - this field
 * shape is identical on both editions, only the CRD group/kind differs.
 *
 * Config:
 *   policyName: string,           // Default: 'mcp-tool-access'
 *   backendName: string,         // Backend to restrict (default: 'mcp-backend')
 *   action: string,              // Allow | Deny (default: 'Allow')
 *   matchExpressions: string[],  // CEL expressions (OR logic), e.g. ['jwt.sub == "user1" && mcp.tool.name == "get_stock_price"']
 */
export class McpToolAccessFeature extends Feature {
  constructor(name, config) {
    super(name, config);

    this.policyName = config.policyName || 'mcp-tool-access';
    this.backendName = config.backendName || 'mcp-backend';
    this.action = config.action || 'Allow';
    this.matchExpressions = Array.isArray(config.matchExpressions) ? config.matchExpressions : [];
  }

  getFeaturePath() {
    return 'mcp-tool-access';
  }

  validate() {
    if (!this.backendName) {
      throw new Error('mcp-tool-access requires backendName (backend to restrict)');
    }
    if (this.matchExpressions.length === 0) {
      throw new Error('mcp-tool-access requires at least one matchExpression (CEL)');
    }
    return true;
  }

  async deploy() {
    this.log('Applying MCP tool access policy...', 'info');

    const policy = {
      apiVersion: policyApiVersion(this.edition),
      kind: POLICY_KIND[this.edition],
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
            group: BACKEND_API_GROUP[this.edition],
            kind: BACKEND_KIND[this.edition],
            name: this.backendName,
          },
        ],
        backend: {
          mcp: {
            authorization: {
              action: this.action,
              policy: {
                matchExpressions: this.matchExpressions,
              },
            },
          },
        },
      },
    };

    await this.applyResource(policy);
    this.log(
      `${POLICY_KIND[this.edition]} '${this.policyName}' (tool access) applied to backend '${this.backendName}'`,
      'success'
    );
  }

  async cleanup() {
    this.log('Cleaning up MCP tool access policy...', 'info');
    await this.deleteResource(POLICY_KIND[this.edition], this.policyName);
    this.log('MCP tool access policy removed', 'success');
  }
}

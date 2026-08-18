import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const config = {
  namespace: 'agentgateway-system',
  backendName: 'mcp-backend',
  action: 'Allow',
  matchExpressions: ['mcp.tool.name == "get_stock_price"'],
};

describe('McpToolAccessFeature edition branching', () => {
  test('enterprise (default) emits EnterpriseAgentgatewayPolicy', async () => {
    const docs = await FeatureManager.deploy('mcp-tool-access', config, { dryRun: true });
    const policy = yaml.load(docs[0]);
    expect(policy.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(policy.kind).toBe('EnterpriseAgentgatewayPolicy');
    expect(policy.spec.backend.mcp.authorization.action).toBe('Allow');
    expect(policy.spec.backend.mcp.authorization.policy.matchExpressions).toEqual(
      config.matchExpressions
    );
  });

  test('edition: enterprise resolves identically to omitting the edition option', async () => {
    const withoutEdition = await FeatureManager.deploy('mcp-tool-access', config, {
      dryRun: true,
    });
    const withEnterprise = await FeatureManager.deploy('mcp-tool-access', config, {
      dryRun: true,
      edition: 'enterprise',
    });
    expect(withoutEdition).toEqual(withEnterprise);
  });

  test('edition: opensource emits AgentgatewayPolicy with the same backend.mcp.authorization shape', async () => {
    const docs = await FeatureManager.deploy('mcp-tool-access', config, {
      dryRun: true,
      edition: 'opensource',
    });
    const policy = yaml.load(docs[0]);
    expect(policy.apiVersion).toBe('agentgateway.dev/v1alpha1');
    expect(policy.kind).toBe('AgentgatewayPolicy');
    expect(policy.spec.backend.mcp.authorization.action).toBe('Allow');
    expect(policy.spec.backend.mcp.authorization.policy.matchExpressions).toEqual(
      config.matchExpressions
    );
  });
});

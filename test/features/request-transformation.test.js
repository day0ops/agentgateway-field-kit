import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const config = {
  namespace: 'agentgateway-system',
  transformations: [{ field: 'max_completion_tokens', expression: '500' }],
  targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'openai' }],
};

describe('RequestTransformationFeature edition branching', () => {
  test('enterprise (default) emits EnterpriseAgentgatewayPolicy', async () => {
    const docs = await FeatureManager.deploy('request-transformation', config, { dryRun: true });
    const policy = yaml.load(docs[0]);
    expect(policy.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(policy.kind).toBe('EnterpriseAgentgatewayPolicy');
    expect(policy.spec.backend.ai.transformations).toEqual(config.transformations);
  });

  test('edition: enterprise resolves identically to omitting the edition option', async () => {
    const withoutEdition = await FeatureManager.deploy('request-transformation', config, {
      dryRun: true,
    });
    const withEnterprise = await FeatureManager.deploy('request-transformation', config, {
      dryRun: true,
      edition: 'enterprise',
    });
    expect(withoutEdition).toEqual(withEnterprise);
  });

  test('edition: opensource emits AgentgatewayPolicy with the same backend.ai.transformations shape', async () => {
    const docs = await FeatureManager.deploy('request-transformation', config, {
      dryRun: true,
      edition: 'opensource',
    });
    const policy = yaml.load(docs[0]);
    expect(policy.apiVersion).toBe('agentgateway.dev/v1alpha1');
    expect(policy.kind).toBe('AgentgatewayPolicy');
    expect(policy.spec.backend.ai.transformations).toEqual(config.transformations);
  });
});

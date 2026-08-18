import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const config = {
  namespace: 'agentgateway-system',
  prepend: [{ role: 'SYSTEM', content: 'You are a helpful assistant.' }],
  targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'openai' }],
};

describe('PromptEnrichmentFeature edition branching', () => {
  test('enterprise (default) emits EnterpriseAgentgatewayPolicy', async () => {
    const docs = await FeatureManager.deploy('prompt-enrichment', config, { dryRun: true });
    const policy = yaml.load(docs[0]);
    expect(policy.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(policy.kind).toBe('EnterpriseAgentgatewayPolicy');
    expect(policy.spec.backend.ai.prompt.prepend).toEqual([
      { role: 'system', content: 'You are a helpful assistant.' },
    ]);
  });

  test('edition: enterprise resolves identically to omitting the edition option', async () => {
    const withoutEdition = await FeatureManager.deploy('prompt-enrichment', config, {
      dryRun: true,
    });
    const withEnterprise = await FeatureManager.deploy('prompt-enrichment', config, {
      dryRun: true,
      edition: 'enterprise',
    });
    expect(withoutEdition).toEqual(withEnterprise);
  });

  test('edition: opensource emits AgentgatewayPolicy with the same backend.ai.prompt shape', async () => {
    const docs = await FeatureManager.deploy('prompt-enrichment', config, {
      dryRun: true,
      edition: 'opensource',
    });
    const policy = yaml.load(docs[0]);
    expect(policy.apiVersion).toBe('agentgateway.dev/v1alpha1');
    expect(policy.kind).toBe('AgentgatewayPolicy');
    expect(policy.spec.backend.ai.prompt.prepend).toEqual([
      { role: 'system', content: 'You are a helpful assistant.' },
    ]);
  });
});

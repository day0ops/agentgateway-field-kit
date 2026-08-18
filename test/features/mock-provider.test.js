import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

const config = { namespace: 'agentgateway-system', model: 'test-model' };

describe('MockProviderFeature edition branching', () => {
  test('enterprise (default) emits EnterpriseAgentgatewayBackend', async () => {
    const docs = await FeatureManager.deploy('mock-provider', config, { dryRun: true });
    const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'mock-openai-backend');
    expect(backend.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    const route = findDoc(docs, 'HTTPRoute', 'mock-openai');
    expect(route.spec.rules[0].backendRefs[0]).toEqual({
      name: 'mock-openai-backend',
      group: 'enterpriseagentgateway.solo.io',
      kind: 'EnterpriseAgentgatewayBackend',
    });
  });

  test('edition: opensource emits AgentgatewayBackend with the same ai.provider/policies.auth shape', async () => {
    const docs = await FeatureManager.deploy('mock-provider', config, {
      dryRun: true,
      edition: 'opensource',
    });
    const backend = findDoc(docs, 'AgentgatewayBackend', 'mock-openai-backend');
    expect(backend.apiVersion).toBe('agentgateway.dev/v1alpha1');
    expect(backend.spec.ai.provider.openai).toEqual({ model: 'test-model' });
    expect(backend.spec.policies.auth).toEqual({ passthrough: {} });
    const route = findDoc(docs, 'HTTPRoute', 'mock-openai');
    expect(route.spec.rules[0].backendRefs[0]).toEqual({
      name: 'mock-openai-backend',
      group: 'agentgateway.dev',
      kind: 'AgentgatewayBackend',
    });
  });
});

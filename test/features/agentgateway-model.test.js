import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';
import { AgentgatewayModelFeature } from '../../features/agentgateway-model/index.js';

describe('AgentgatewayModelFeature provider support', () => {
  test('openai concrete model emits provider: OpenAI and an openai-secret auth ref', async () => {
    const docs = await FeatureManager.deploy(
      'agentgateway-model',
      { models: [{ name: 'gpt-4o-mini', provider: 'openai' }] },
      { dryRun: true }
    );
    const model = docs.map(d => yaml.load(d)).find(d => d.kind === 'AgentgatewayModel');

    expect(model.spec.provider).toBe('OpenAI');
    expect(model.spec.policies.auth.secretRef).toEqual({ name: 'openai-secret' });
  });

  test('anthropic concrete model emits provider: Anthropic and an anthropic-secret auth ref', async () => {
    const docs = await FeatureManager.deploy(
      'agentgateway-model',
      { models: [{ name: 'claude-sonnet-5', provider: 'anthropic' }] },
      { dryRun: true }
    );
    const model = docs.map(d => yaml.load(d)).find(d => d.kind === 'AgentgatewayModel');

    expect(model.spec.provider).toBe('Anthropic');
    expect(model.spec.policies.auth.secretRef).toEqual({ name: 'anthropic-secret' });
  });

  test('mixing openai and anthropic models creates exactly one secret per provider', async () => {
    const docs = await FeatureManager.deploy(
      'agentgateway-model',
      {
        models: [
          { name: 'gpt-4o-mini', provider: 'openai' },
          { name: 'claude-sonnet-5', provider: 'anthropic' },
        ],
      },
      { dryRun: true }
    );
    const secrets = docs.map(d => yaml.load(d)).filter(d => d.kind === 'Secret');

    expect(secrets.map(s => s.metadata.name).sort()).toEqual(['anthropic-secret', 'openai-secret']);
  });

  test('a virtualModel failover can mix targets across providers', async () => {
    const docs = await FeatureManager.deploy(
      'agentgateway-model',
      {
        models: [
          { name: 'internal-openai', provider: 'openai', visibility: 'Internal' },
          { name: 'internal-anthropic', provider: 'anthropic', visibility: 'Internal' },
          {
            name: 'resilient-chat',
            virtualModel: {
              failover: {
                targets: [
                  { name: 'internal-openai', priority: 0 },
                  { name: 'internal-anthropic', priority: 1 },
                ],
              },
            },
          },
        ],
      },
      { dryRun: true }
    );
    const virtual = docs.map(d => yaml.load(d)).find(d => d.metadata.name === 'resilient-chat');

    expect(virtual.spec.virtualModel.failover.targets).toEqual([
      { modelRef: { name: 'internal-openai' }, priority: 0 },
      { modelRef: { name: 'internal-anthropic' }, priority: 1 },
    ]);
  });

  test('validate() throws on an unsupported provider', () => {
    const feature = new AgentgatewayModelFeature('agentgateway-model', {
      models: [{ name: 'x', provider: 'vertex-ai' }],
    });
    expect(() => feature.validate()).toThrow(/unsupported provider 'vertex-ai'/);
  });

  test('validate() throws when a model sets both provider and virtualModel', () => {
    const feature = new AgentgatewayModelFeature('agentgateway-model', {
      models: [{ name: 'x', provider: 'openai', virtualModel: { weighted: { targets: [] } } }],
    });
    expect(() => feature.validate()).toThrow(/must set exactly one of provider or virtualModel/);
  });
});

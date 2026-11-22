import { test, expect, describe, beforeEach } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';
import { AgentgatewayModelFeature } from '../../features/agentgateway-model/index.js';

// FeatureManager.gatewayRef is a static, process-wide field other test files mutate via
// setGatewayRef() without resetting - reset it here so this file's expectations don't
// depend on which other test files already ran in this process (same pattern as
// test/features/agentgateway-demo-wizard.test.js).
beforeEach(() => {
  FeatureManager.gatewayRef = null;
});

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

  test('validate() throws when httpRoute is set without a name', () => {
    const feature = new AgentgatewayModelFeature('agentgateway-model', {
      httpRoute: { pathPrefix: '/multi-model' },
      models: [{ name: 'x', provider: 'openai' }],
    });
    expect(() => feature.validate()).toThrow(/httpRoute.name is required/);
  });

  test('validate() throws when httpRoute is set without a pathPrefix', () => {
    const feature = new AgentgatewayModelFeature('agentgateway-model', {
      httpRoute: { name: 'multi-model-routing' },
      models: [{ name: 'x', provider: 'openai' }],
    });
    expect(() => feature.validate()).toThrow(/pathPrefix is required/);
  });

  test('validate() throws when httpRoute.pathPrefix is the root path', () => {
    const feature = new AgentgatewayModelFeature('agentgateway-model', {
      httpRoute: { name: 'multi-model-routing', pathPrefix: '/' },
      models: [{ name: 'x', provider: 'openai' }],
    });
    expect(() => feature.validate()).toThrow(/must not be "\/"/);
  });
});

describe('AgentgatewayModelFeature httpRoute attachment', () => {
  test('without httpRoute, a model attaches straight to the Gateway (the default)', async () => {
    const docs = await FeatureManager.deploy(
      'agentgateway-model',
      { sectionName: 'https', models: [{ name: 'gpt-4o-mini', provider: 'openai' }] },
      { dryRun: true }
    );
    const model = docs.map(d => yaml.load(d)).find(d => d.kind === 'AgentgatewayModel');

    expect(model.spec.parentRefs).toEqual([
      {
        group: 'gateway.networking.k8s.io',
        kind: 'Gateway',
        name: 'agentgateway-gw',
        namespace: 'agentgateway-system',
        sectionName: 'https',
      },
    ]);
    expect(docs.some(d => yaml.load(d).kind === 'HTTPRoute')).toBe(false);
  });

  test('with httpRoute, every model attaches to the named HTTPRoute instead, plus the HTTPRoute itself gets created', async () => {
    const docs = await FeatureManager.deploy(
      'agentgateway-model',
      {
        sectionName: 'https',
        httpRoute: { name: 'multi-model-routing', pathPrefix: '/multi-model' },
        models: [
          { name: 'gpt-4o-mini', provider: 'openai' },
          { name: 'claude-sonnet-5', provider: 'anthropic' },
        ],
      },
      { dryRun: true }
    );
    const loaded = docs.map(d => yaml.load(d));
    const models = loaded.filter(d => d.kind === 'AgentgatewayModel');
    const route = loaded.find(d => d.kind === 'HTTPRoute');

    expect(models).toHaveLength(2);
    for (const model of models) {
      expect(model.spec.parentRefs).toEqual([
        {
          group: 'gateway.networking.k8s.io',
          kind: 'HTTPRoute',
          name: 'multi-model-routing',
          namespace: 'agentgateway-system',
          sectionName: 'models',
        },
      ]);
    }

    expect(route.metadata.name).toBe('multi-model-routing');
    expect(route.spec.parentRefs).toEqual([
      { name: 'agentgateway-gw', namespace: 'agentgateway-system', sectionName: 'https' },
    ]);
    expect(route.spec.rules).toEqual([
      {
        name: 'models',
        matches: [{ path: { type: 'PathPrefix', value: '/multi-model' } }],
        backendRefs: [{ group: 'agentgateway.dev', kind: 'AgentgatewayModel', name: '*' }],
      },
    ]);
  });
});

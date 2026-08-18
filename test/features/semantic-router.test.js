import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('SemanticRouterFeature', () => {
  test('deploys a single simulated backend serving the premium model as a LoRA over the cheap base model', async () => {
    const docs = await FeatureManager.deploy(
      'semantic-router',
      { namespace: 'agentgateway-system' },
      { dryRun: true }
    );
    const deployment = findDoc(docs, 'Deployment', 'semantic-router-models');
    expect(deployment).toBeTruthy();
    const args = deployment.spec.template.spec.containers[0].args;
    expect(args).toEqual([
      '--model',
      'cheap-model',
      '--port',
      '8000',
      '--lora-modules',
      JSON.stringify({
        name: 'premium-model',
        path: '/loras/premium-model',
        base_model_name: 'cheap-model',
      }),
    ]);
    expect(findDoc(docs, 'Service', 'semantic-router-models')).toBeTruthy();
  });

  test('the selected backend points at the shared models Service, not an empty passthrough provider', async () => {
    const docs = await FeatureManager.deploy(
      'semantic-router',
      { namespace: 'agentgateway-system' },
      { dryRun: true }
    );
    const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'semantic-router-selected');
    expect(backend.spec.ai.provider).toEqual({
      openai: {},
      host: 'semantic-router-models.agentgateway-system.svc.cluster.local',
      port: 8000,
      path: '/v1/chat/completions',
    });
    expect(backend.spec.policies.auth).toEqual({ passthrough: {} });
  });

  test('the HTTPRoute matches /v1/chat/completions and /v1/responses', async () => {
    const docs = await FeatureManager.deploy(
      'semantic-router',
      { namespace: 'agentgateway-system' },
      { dryRun: true }
    );
    const route = findDoc(docs, 'HTTPRoute', 'semantic-router');
    const paths = route.spec.rules[0].matches.map(m => m.path.value);
    expect(paths).toEqual(['/v1/chat/completions', '/v1/responses']);
  });

  test('enterprise (default) emits an EnterpriseAgentgatewayPolicy for ExtProc', async () => {
    const docs = await FeatureManager.deploy(
      'semantic-router',
      { namespace: 'agentgateway-system' },
      { dryRun: true }
    );
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'semantic-router-extproc');
    expect(policy.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(policy.spec.traffic.extProc.processingOptions.requestBodyMode).toBe(
      'FullDuplexStreamed'
    );
    expect(policy.spec.traffic.extProc.backendRef).toEqual({
      name: 'semantic-router',
      namespace: 'agentgateway-system',
      port: 50051,
    });
  });

  test('edition: opensource emits a plain AgentgatewayPolicy for ExtProc', async () => {
    const docs = await FeatureManager.deploy(
      'semantic-router',
      { namespace: 'agentgateway-system' },
      { dryRun: true, edition: 'opensource' }
    );
    const policy = findDoc(docs, 'AgentgatewayPolicy', 'semantic-router-extproc');
    expect(policy.apiVersion).toBe('agentgateway.dev/v1alpha1');
    expect(
      findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'semantic-router-extproc')
    ).toBeUndefined();
  });

  test('config.cheapModel/premiumModel rename the routing decision targets', async () => {
    const docs = await FeatureManager.deploy(
      'semantic-router',
      { namespace: 'agentgateway-system', cheapModel: 'mini', premiumModel: 'max' },
      { dryRun: true }
    );
    const valuesDoc = docs.find(d => d.includes('config:') && d.includes('providers:'));
    const values = yaml.load(
      valuesDoc
        .split('\n')
        .filter(l => !l.trim().startsWith('#'))
        .join('\n')
    );
    expect(values.config.providers.defaults.default_model).toBe('mini');
    expect(values.config.providers.models.map(m => m.name)).toEqual(['mini', 'max']);

    const deployment = findDoc(docs, 'Deployment', 'semantic-router-models');
    expect(deployment.spec.template.spec.containers[0].args).toEqual([
      '--model',
      'mini',
      '--port',
      '8000',
      '--lora-modules',
      JSON.stringify({ name: 'max', path: '/loras/max', base_model_name: 'mini' }),
    ]);
  });

  test('edition: opensource emits a plain AgentgatewayBackend for the selected backend', async () => {
    const docs = await FeatureManager.deploy(
      'semantic-router',
      { namespace: 'agentgateway-system' },
      { dryRun: true, edition: 'opensource' }
    );
    expect(findDoc(docs, 'AgentgatewayBackend', 'semantic-router-selected')).toBeTruthy();
    expect(
      findDoc(docs, 'EnterpriseAgentgatewayBackend', 'semantic-router-selected')
    ).toBeUndefined();
  });
});

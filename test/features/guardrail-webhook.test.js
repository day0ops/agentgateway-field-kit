import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const config = {
  namespace: 'agentgateway-system',
  targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'openai' }],
};

function policyDoc(docs) {
  return docs.map(d => yaml.load(d)).find(d => d.spec?.backend?.ai?.promptGuard);
}

describe('GuardrailWebhookFeature edition branching', () => {
  test('enterprise (default) emits EnterpriseAgentgatewayPolicy with promptGuard.webhook', async () => {
    const docs = await FeatureManager.deploy('guardrail-webhook', config, { dryRun: true });
    const policy = policyDoc(docs);
    expect(policy.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(policy.kind).toBe('EnterpriseAgentgatewayPolicy');
    expect(policy.spec.backend.ai.promptGuard.request[0].webhook.backendRef.name).toBe(
      'opik-guardrail-webhook'
    );
    expect(policy.spec.backend.ai.promptGuard.response[0].webhook.backendRef.name).toBe(
      'opik-guardrail-webhook'
    );
  });

  test('edition: enterprise resolves identically to omitting the edition option', async () => {
    const withoutEdition = await FeatureManager.deploy('guardrail-webhook', config, {
      dryRun: true,
    });
    const withEnterprise = await FeatureManager.deploy('guardrail-webhook', config, {
      dryRun: true,
      edition: 'enterprise',
    });
    expect(withoutEdition).toEqual(withEnterprise);
  });

  test('edition: opensource emits AgentgatewayPolicy with the same promptGuard.webhook shape', async () => {
    const docs = await FeatureManager.deploy('guardrail-webhook', config, {
      dryRun: true,
      edition: 'opensource',
    });
    const policy = policyDoc(docs);
    expect(policy.apiVersion).toBe('agentgateway.dev/v1alpha1');
    expect(policy.kind).toBe('AgentgatewayPolicy');
    expect(policy.spec.backend.ai.promptGuard.request[0].webhook.backendRef.name).toBe(
      'opik-guardrail-webhook'
    );
  });
});

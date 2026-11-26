import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const config = {
  namespace: 'agentgateway-system',
  targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'openai' }],
  webhook: { image: 'test-registry/f5-guardrail-webhook:test' },
};

function policyDoc(docs) {
  return docs.map(d => yaml.load(d)).find(d => d.spec?.backend?.ai?.promptGuard);
}

function deploymentDoc(docs) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === 'Deployment');
}

describe('F5GuardrailFeature', () => {
  test('emits EnterpriseAgentgatewayPolicy with promptGuard.webhook targeting the real backend', async () => {
    const docs = await FeatureManager.deploy('f5-guardrail', config, { dryRun: true });
    const policy = policyDoc(docs);
    expect(policy.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(policy.kind).toBe('EnterpriseAgentgatewayPolicy');
    expect(policy.metadata.name).toBe('f5-guardrail');
    expect(policy.spec.targetRefs).toEqual(config.targetRefs);
    expect(policy.spec.backend.ai.promptGuard.request[0].webhook.backendRef.name).toBe(
      'f5-guardrail-webhook'
    );
    expect(policy.spec.backend.ai.promptGuard.response[0].webhook.backendRef.name).toBe(
      'f5-guardrail-webhook'
    );
  });

  test('deploys the adapter Deployment with F5 env vars wired in', async () => {
    const docs = await FeatureManager.deploy('f5-guardrail', config, { dryRun: true });
    const deployment = deploymentDoc(docs);
    const container = deployment.spec.template.spec.containers[0];
    expect(container.image).toBe('test-registry/f5-guardrail-webhook:test');
    expect(container.readinessProbe.httpGet.path).toBe('/healthz');
    const envNames = container.env.map(e => e.name);
    expect(envNames).toContain('F5_AISEC_URL');
    expect(envNames).toContain('CAI_PROJECT');
    expect(envNames).toContain('F5_AISEC_TOKEN');
    const tokenEnv = container.env.find(e => e.name === 'F5_AISEC_TOKEN');
    expect(tokenEnv.valueFrom.secretKeyRef).toEqual({ name: 'f5-aisec-secret', key: 'token' });
  });

  test('rejects edition: opensource before touching Kubernetes', async () => {
    await expect(
      FeatureManager.deploy('f5-guardrail', config, { dryRun: true, edition: 'opensource' })
    ).rejects.toThrow(/does not support edition 'opensource'/);
  });

  test('dryRun never requires F5_AISEC_URL/F5_AISEC_TOKEN/CAI_PROJECT to be set', async () => {
    const saved = {
      url: process.env.F5_AISEC_URL,
      token: process.env.F5_AISEC_TOKEN,
      project: process.env.CAI_PROJECT,
    };
    delete process.env.F5_AISEC_URL;
    delete process.env.F5_AISEC_TOKEN;
    delete process.env.CAI_PROJECT;
    try {
      await expect(
        FeatureManager.deploy('f5-guardrail', config, { dryRun: true })
      ).resolves.toBeDefined();
    } finally {
      if (saved.url !== undefined) process.env.F5_AISEC_URL = saved.url;
      if (saved.token !== undefined) process.env.F5_AISEC_TOKEN = saved.token;
      if (saved.project !== undefined) process.env.CAI_PROJECT = saved.project;
    }
  });

  test('response: false omits the response webhook entry entirely', async () => {
    const docs = await FeatureManager.deploy(
      'f5-guardrail',
      { ...config, response: false },
      { dryRun: true }
    );
    const policy = policyDoc(docs);
    expect(policy.spec.backend.ai.promptGuard.request).toBeDefined();
    expect(policy.spec.backend.ai.promptGuard.response).toBeUndefined();
  });

  test('request: false omits the request webhook entry entirely', async () => {
    const docs = await FeatureManager.deploy(
      'f5-guardrail',
      { ...config, request: false },
      { dryRun: true }
    );
    const policy = policyDoc(docs);
    expect(policy.spec.backend.ai.promptGuard.response).toBeDefined();
    expect(policy.spec.backend.ai.promptGuard.request).toBeUndefined();
  });
});

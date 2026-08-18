import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const targetRefs = [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'openai' }];

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('WafFeature', () => {
  test('requires at least one targetRef', async () => {
    await expect(
      FeatureManager.deploy('waf', { namespace: 'agentgateway-system' }, { dryRun: true })
    ).rejects.toThrow(/at least one entry in config.targetRefs/);
  });

  test('scopes the block rule to ARGS:json.model, not bare ARGS', async () => {
    const docs = await FeatureManager.deploy(
      'waf',
      { namespace: 'agentgateway-system', targetRefs },
      { dryRun: true }
    );
    const wafPolicy = findDoc(docs, 'WAFPolicy', 'waf-policy');
    const rule = wafPolicy.spec.customDirectives[0].inline;
    expect(rule).toContain('ARGS:json.model');
    expect(rule).not.toMatch(/SecRule ARGS "/);
  });

  test('enables JSON body parsing and request body processing', async () => {
    const docs = await FeatureManager.deploy(
      'waf',
      { namespace: 'agentgateway-system', targetRefs },
      { dryRun: true }
    );
    const wafPolicy = findDoc(docs, 'WAFPolicy', 'waf-policy');
    expect(wafPolicy.spec.processingConfig.request.mode).toBe('HeadersAndBody');
    expect(wafPolicy.spec.ruleEngineSettings.inline).toContain('ctl:requestBodyProcessor=JSON');
  });

  test('joins multiple disallowedModels into one alternation pattern', async () => {
    const docs = await FeatureManager.deploy(
      'waf',
      { namespace: 'agentgateway-system', targetRefs, disallowedModels: ['gpt-4', 'gpt-4-turbo'] },
      { dryRun: true }
    );
    const wafPolicy = findDoc(docs, 'WAFPolicy', 'waf-policy');
    expect(wafPolicy.spec.customDirectives[0].inline).toContain('^(gpt-4|gpt-4-turbo)$');
  });

  test('customInterventionResponse carries the configured status code and a blocked-by header', async () => {
    const docs = await FeatureManager.deploy(
      'waf',
      { namespace: 'agentgateway-system', targetRefs, statusCode: 451 },
      { dryRun: true }
    );
    const wafPolicy = findDoc(docs, 'WAFPolicy', 'waf-policy');
    expect(wafPolicy.spec.customInterventionResponse.statusCode).toBe(451);
    expect(wafPolicy.spec.customInterventionResponse.headers.setHeaders).toEqual([
      { name: 'x-blocked-by', value: 'waf-policy' },
    ]);
  });

  test('wires the EnterpriseAgentgatewayPolicy to the WAFPolicy via traffic.entWAF.wafPolicyRef', async () => {
    const docs = await FeatureManager.deploy(
      'waf',
      { namespace: 'agentgateway-system', targetRefs },
      { dryRun: true }
    );
    const trafficPolicy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'waf-policy');
    expect(trafficPolicy.spec.targetRefs).toEqual(targetRefs);
    expect(trafficPolicy.spec.traffic.entWAF.wafPolicyRef).toEqual({
      name: 'waf-policy',
      namespace: 'agentgateway-system',
    });
  });
});

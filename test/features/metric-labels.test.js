import { test, expect, describe, beforeEach } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';
import { MetricLabelsFeature } from '../../features/metric-labels/index.js';

const config = {
  labels: [
    { name: 'org', expression: 'jwt.org_id' },
    { name: 'team', expression: 'jwt.team_id' },
    { name: 'user', expression: 'jwt.sub' },
  ],
};

// FeatureManager.gatewayRef is a static, process-wide field other test files mutate via
// setGatewayRef() without resetting - reset it here so this file's expectations don't
// depend on which other test files already ran in this process (same pattern as
// test/features/agentgateway-demo-wizard.test.js).
beforeEach(() => {
  FeatureManager.gatewayRef = null;
});

describe('MetricLabelsFeature', () => {
  test('edition: opensource emits AgentgatewayPolicy with spec.metrics.attributes.add', async () => {
    const docs = await FeatureManager.deploy('metric-labels', config, {
      dryRun: true,
      edition: 'opensource',
    });
    expect(docs.length).toBe(1);
    const policy = yaml.load(docs[0]);

    expect(policy.apiVersion).toBe('agentgateway.dev/v1alpha1');
    expect(policy.kind).toBe('AgentgatewayPolicy');
    expect(policy.spec.metrics.attributes.add).toEqual(config.labels);
  });

  test('edition: enterprise (default) emits EnterpriseAgentgatewayPolicy with the same shape', async () => {
    const docs = await FeatureManager.deploy('metric-labels', config, { dryRun: true });
    const policy = yaml.load(docs[0]);

    expect(policy.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(policy.kind).toBe('EnterpriseAgentgatewayPolicy');
    expect(policy.spec.metrics.attributes.add).toEqual(config.labels);
  });

  test('defaults targetRefs to the current Gateway ref (FeatureManager.getGatewayRef())', async () => {
    // Matches a real usecase pipeline, where the gateway/providers feature has already set
    // the live Gateway ref via setGatewayRef() before metric-labels runs - not something
    // this feature computes itself. getGatewayRef() is not edition-aware on its own (its
    // fallback is a single static default, confirmed in src/lib/feature.js); the opensource
    // name here comes from the explicit setGatewayRef() call, the same pattern every other
    // dual-edition feature (rate-limit, virtual-keys, model-costs) relies on and none of
    // their own test files exercise without it either.
    FeatureManager.setGatewayRef({ name: 'agentgateway-oss-gw' });
    const docs = await FeatureManager.deploy('metric-labels', config, {
      dryRun: true,
      edition: 'opensource',
    });
    const policy = yaml.load(docs[0]);
    expect(policy.spec.targetRefs).toEqual([
      { group: 'gateway.networking.k8s.io', kind: 'Gateway', name: 'agentgateway-oss-gw' },
    ]);
  });

  test('falls back to the default Gateway name when no live ref has been set', async () => {
    const docs = await FeatureManager.deploy('metric-labels', config, { dryRun: true });
    const policy = yaml.load(docs[0]);
    expect(policy.spec.targetRefs).toEqual([
      { group: 'gateway.networking.k8s.io', kind: 'Gateway', name: 'agentgateway-gw' },
    ]);
  });

  test('validate() throws when labels is empty', () => {
    const feature = new MetricLabelsFeature('metric-labels', { labels: [] });
    expect(() => feature.validate()).toThrow(/at least one label is required/);
  });

  test('validate() throws when labels has more than 16 entries', () => {
    const labels = Array.from({ length: 17 }, (_, i) => ({ name: `l${i}`, expression: 'true' }));
    const feature = new MetricLabelsFeature('metric-labels', { labels });
    expect(() => feature.validate()).toThrow(/at most 16 labels/);
  });

  test('validate() throws when a label is missing name or expression', () => {
    const feature = new MetricLabelsFeature('metric-labels', {
      labels: [{ name: 'org' }],
    });
    expect(() => feature.validate()).toThrow(/each label requires a name and an expression/);
  });
});

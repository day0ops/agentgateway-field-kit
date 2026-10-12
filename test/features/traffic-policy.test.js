import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';
import { TrafficPolicyFeature } from '../../features/traffic-policy/index.js';

describe('TrafficPolicyFeature', () => {
  test('validate() throws without targetRef.name', () => {
    const feature = new TrafficPolicyFeature('traffic-policy', {
      timeouts: { request: '1s' },
    });
    expect(() => feature.validate()).toThrow(/targetRef.name/);
  });

  test('validate() throws without timeouts, retry, or headerModifiers', () => {
    const feature = new TrafficPolicyFeature('traffic-policy', {
      targetRef: { name: 'openai' },
    });
    expect(() => feature.validate()).toThrow(/timeouts, retry, or headerModifiers/);
  });

  test('emits spec.traffic.headerModifiers for a header-remove config', async () => {
    const config = {
      targetRef: { name: 'openai' },
      headerModifiers: { request: { remove: ['sec-websocket-extensions'] } },
    };
    const docs = await FeatureManager.deploy('traffic-policy', config, { dryRun: true });
    const policy = yaml.load(docs[0]);
    expect(policy.kind).toBe('EnterpriseAgentgatewayPolicy');
    expect(policy.spec.targetRefs[0]).toEqual({
      group: 'gateway.networking.k8s.io',
      kind: 'HTTPRoute',
      name: 'openai',
    });
    expect(policy.spec.traffic.headerModifiers).toEqual(config.headerModifiers);
    expect(policy.spec.traffic.timeouts).toBeUndefined();
  });

  test('timeouts and headerModifiers can be combined on the same policy', async () => {
    const config = {
      targetRef: { name: 'openai' },
      timeouts: { request: '2s' },
      headerModifiers: { request: { remove: ['sec-websocket-extensions'] } },
    };
    const docs = await FeatureManager.deploy('traffic-policy', config, { dryRun: true });
    const policy = yaml.load(docs[0]);
    expect(policy.spec.traffic.timeouts).toEqual(config.timeouts);
    expect(policy.spec.traffic.headerModifiers).toEqual(config.headerModifiers);
  });
});

import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const config = {
  keys: [
    { name: 'alice', key: 'sk-alice-demo-abc123def456', userId: 'alice', tokenBudget: 10000 },
    { name: 'bob', key: 'sk-bob-demo-xyz789uvw012', userId: 'bob', tokenBudget: 1000 },
  ],
};

describe('VirtualKeysFeature (single merged policy regression test)', () => {
  test('emits exactly one EnterpriseAgentgatewayPolicy containing both apiKeyAuthentication and entRateLimit', async () => {
    const docs = await FeatureManager.deploy('virtual-keys', config, { dryRun: true });
    const parsed = docs.map(d => yaml.load(d));

    const policies = parsed.filter(d => d?.kind === 'EnterpriseAgentgatewayPolicy');
    expect(policies.length).toBe(1);

    const policy = policies[0];
    expect(policy.spec.traffic.apiKeyAuthentication).toEqual({
      mode: 'Strict',
      secretRef: { name: 'virtual-keys' },
    });
    expect(policy.spec.traffic.entRateLimit.global.rateLimitConfigRefs).toEqual([
      { name: 'virtual-keys-ratelimit' },
    ]);
  });

  test('RateLimitConfig has one descriptor entry per key', async () => {
    const docs = await FeatureManager.deploy('virtual-keys', config, { dryRun: true });
    const parsed = docs.map(d => yaml.load(d));

    const rateLimitConfig = parsed.find(d => d?.kind === 'RateLimitConfig');
    expect(rateLimitConfig).toBeTruthy();
    expect(rateLimitConfig.apiVersion).toBe('ratelimit.solo.io/v1alpha1');
    expect(rateLimitConfig.spec.raw.descriptors).toEqual([
      { key: 'user_id', value: 'alice', rateLimit: { unit: 'HOUR', requestsPerUnit: 10000 } },
      { key: 'user_id', value: 'bob', rateLimit: { unit: 'HOUR', requestsPerUnit: 1000 } },
    ]);
    expect(rateLimitConfig.spec.raw.rateLimits).toEqual([
      { actions: [{ cel: { expression: 'apiKey.user_id', key: 'user_id' } }], type: 'TOKEN' },
    ]);
  });

  test("Secret metadata includes both id (native virtualKey budget subject via apiKey.id) and user_id (this feature's own rate-limit CEL)", async () => {
    const docs = await FeatureManager.deploy('virtual-keys', config, { dryRun: true });
    const secret = docs.map(d => yaml.load(d)).find(d => d?.kind === 'Secret');

    expect(JSON.parse(secret.stringData.alice)).toEqual({
      key: 'sk-alice-demo-abc123def456',
      metadata: { id: 'alice', user_id: 'alice' },
    });
  });

  test('no rateLimitBackendRef/backendRef anywhere in the generated YAML', async () => {
    const docs = await FeatureManager.deploy('virtual-keys', config, { dryRun: true });
    const combined = docs.join('\n');
    expect(combined).not.toMatch(/rateLimitBackendRef/);
    expect(combined).not.toMatch(/backendRef/);
    expect(combined).not.toMatch(/rate-limit-server/);
  });

  test('rejects edition: opensource before touching Kubernetes', async () => {
    await expect(
      FeatureManager.deploy('virtual-keys', config, { dryRun: true, edition: 'opensource' })
    ).rejects.toThrow(/does not support edition 'opensource'/);
  });

  test('mode and location are configurable for sharing a route with another auth method', async () => {
    const docs = await FeatureManager.deploy(
      'virtual-keys',
      {
        ...config,
        mode: 'Optional',
        location: { header: { name: 'X-Api-Key' } },
      },
      { dryRun: true }
    );
    const policy = docs
      .map(d => yaml.load(d))
      .find(d => d?.kind === 'EnterpriseAgentgatewayPolicy');

    expect(policy.spec.traffic.apiKeyAuthentication).toEqual({
      mode: 'Optional',
      secretRef: { name: 'virtual-keys' },
      location: { header: { name: 'X-Api-Key' } },
    });
  });
});

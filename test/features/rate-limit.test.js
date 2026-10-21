import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';
import { RateLimitFeature } from '../../features/rate-limit/index.js';

function findDoc(docs, kind) {
  return docs.map(d => yaml.load(d)).find(d => d?.kind === kind);
}

describe('RateLimitFeature global flat mode (regression)', () => {
  test('default config emits a single generic_key REQUEST descriptor', async () => {
    const docs = await FeatureManager.deploy('rate-limit', {}, { dryRun: true });
    const rlc = findDoc(docs, 'RateLimitConfig');
    expect(rlc.spec.raw.descriptors).toEqual([
      { key: 'generic_key', value: 'counter', rateLimit: { requestsPerUnit: 5, unit: 'MINUTE' } },
    ]);
    expect(rlc.spec.raw.rateLimits).toEqual([
      { actions: [{ genericKey: { descriptorValue: 'counter' } }], type: 'REQUEST' },
    ]);
  });
});

describe('RateLimitFeature local mode (regression)', () => {
  test('local mode emits traffic.rateLimit.local, no RateLimitConfig', async () => {
    const docs = await FeatureManager.deploy(
      'rate-limit',
      { mode: 'local', tokens: 5, burst: 2, unit: 'SECOND' },
      { dryRun: true }
    );
    expect(findDoc(docs, 'RateLimitConfig')).toBeUndefined();
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy');
    expect(policy.spec.traffic.rateLimit.local).toEqual([{ unit: 'Seconds', tokens: 5, burst: 2 }]);
  });
});

describe('RateLimitFeature per-tool descriptors', () => {
  const descriptorsConfig = {
    name: 'mcp-per-tool-rate-limit',
    descriptors: [
      {
        match: { method: 'tools/call', tool: 'get_stock_price' },
        requestsPerUnit: 3,
        unit: 'MINUTE',
      },
      { match: { method: 'tools/call' }, requestsPerUnit: 10, unit: 'MINUTE' },
    ],
  };

  test('builds a hierarchical mcp_method -> tool_name descriptor tree', async () => {
    const docs = await FeatureManager.deploy('rate-limit', descriptorsConfig, { dryRun: true });
    const rlc = findDoc(docs, 'RateLimitConfig');

    expect(rlc.spec.raw.descriptors).toEqual([
      {
        key: 'mcp_method',
        value: 'tools/call',
        descriptors: [
          {
            key: 'tool_name',
            value: 'get_stock_price',
            rateLimit: { requestsPerUnit: 3, unit: 'MINUTE' },
          },
          { key: 'tool_name', rateLimit: { requestsPerUnit: 10, unit: 'MINUTE' } },
        ],
      },
    ]);
  });

  test('uses CEL actions (not genericKey) to extract method and tool name', async () => {
    const docs = await FeatureManager.deploy('rate-limit', descriptorsConfig, { dryRun: true });
    const rlc = findDoc(docs, 'RateLimitConfig');

    expect(rlc.spec.raw.rateLimits).toEqual([
      {
        actions: [
          {
            cel: {
              expression:
                'json(request.body).with(body, body.method == "tools/call" ? "tools/call" : "other")',
              key: 'mcp_method',
            },
          },
          {
            cel: {
              expression:
                'json(request.body).with(body, body.method == "tools/call" ? string(body.params.name) : "none")',
              key: 'tool_name',
            },
          },
        ],
        type: 'REQUEST',
      },
    ]);
  });

  test('validate() throws when descriptors is combined with mode: local', () => {
    const feature = new RateLimitFeature('rate-limit', {
      mode: 'local',
      descriptors: descriptorsConfig.descriptors,
    });
    expect(() => feature.validate()).toThrow(
      /descriptors-based rate limiting requires mode: "global"/
    );
  });

  test('validate() throws for an unsupported match.method', () => {
    const feature = new RateLimitFeature('rate-limit', {
      descriptors: [{ match: { method: 'tools/list' }, requestsPerUnit: 5 }],
    });
    expect(() => feature.validate()).toThrow(/only support match.method/);
  });

  test('validate() throws for a missing/invalid requestsPerUnit', () => {
    const feature = new RateLimitFeature('rate-limit', {
      descriptors: [{ match: { tool: 'x' } }],
    });
    expect(() => feature.validate()).toThrow(/positive integer requestsPerUnit/);
  });
});

describe('RateLimitFeature opensource local mode', () => {
  test('flat config (no rules/conditional) emits AgentgatewayPolicy with one local rule', async () => {
    const docs = await FeatureManager.deploy(
      'rate-limit',
      { mode: 'local', tokens: 50, unit: 'HOUR', key: 'apiKey.user_id' },
      { dryRun: true, edition: 'opensource' }
    );
    expect(docs.length).toBe(1);
    const policy = yaml.load(docs[0]);

    expect(policy.apiVersion).toBe('agentgateway.dev/v1alpha1');
    expect(policy.kind).toBe('AgentgatewayPolicy');
    expect(policy.spec.traffic.rateLimit.local).toEqual([
      { unit: 'Hours', tokens: 50, burst: 0, key: 'apiKey.user_id' },
    ]);
  });

  test('rules: [...] stacks multiple local rules on one policy', async () => {
    const docs = await FeatureManager.deploy(
      'rate-limit',
      {
        mode: 'local',
        rules: [
          { tokens: 500000, unit: 'HOUR', key: 'jwt.org_id' },
          { tokens: 50000, unit: 'HOUR', key: 'jwt.team_id' },
          { tokens: 5000, unit: 'HOUR', key: 'jwt.sub' },
        ],
      },
      { dryRun: true, edition: 'opensource' }
    );
    const policy = yaml.load(docs[0]);

    expect(policy.spec.traffic.rateLimit.local).toEqual([
      { unit: 'Hours', tokens: 500000, key: 'jwt.org_id' },
      { unit: 'Hours', tokens: 50000, key: 'jwt.team_id' },
      { unit: 'Hours', tokens: 5000, key: 'jwt.sub' },
    ]);
  });

  test('conditional: [...] emits traffic.rateLimit.conditional, no top-level local', async () => {
    const docs = await FeatureManager.deploy(
      'rate-limit',
      {
        mode: 'local',
        conditional: [
          {
            condition: "apiKey.user_id == 'automation-bot'",
            rules: [{ tokens: 50, unit: 'HOUR' }],
          },
          {
            condition: 'has(jwt)',
            rules: [
              { tokens: 500000, unit: 'HOUR', key: 'jwt.org_id' },
              { tokens: 5000, unit: 'HOUR', key: 'jwt.sub' },
            ],
          },
          { rules: [{ tokens: 1, unit: 'HOUR' }] },
        ],
      },
      { dryRun: true, edition: 'opensource' }
    );
    const policy = yaml.load(docs[0]);

    expect(policy.spec.traffic.rateLimit.local).toBeUndefined();
    expect(policy.spec.traffic.rateLimit.conditional).toEqual([
      {
        condition: "apiKey.user_id == 'automation-bot'",
        policy: { local: [{ unit: 'Hours', tokens: 50 }] },
      },
      {
        condition: 'has(jwt)',
        policy: {
          local: [
            { unit: 'Hours', tokens: 500000, key: 'jwt.org_id' },
            { unit: 'Hours', tokens: 5000, key: 'jwt.sub' },
          ],
        },
      },
      { policy: { local: [{ unit: 'Hours', tokens: 1 }] } },
    ]);
  });

  test('validate() throws when both rules and conditional are set', () => {
    const feature = new RateLimitFeature('rate-limit', {
      mode: 'local',
      rules: [{ tokens: 5, unit: 'HOUR' }],
      conditional: [{ rules: [{ tokens: 5, unit: 'HOUR' }] }],
    });
    expect(() => feature.validate()).toThrow(/rules and conditional are mutually exclusive/);
  });

  test('validate() throws for opensource + mode: global', () => {
    const feature = new RateLimitFeature('rate-limit', { mode: 'global', edition: 'opensource' });
    expect(() => feature.validate()).toThrow(/opensource global rate limiting/);
  });
});

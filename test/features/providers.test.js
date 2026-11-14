import { test, expect, describe, beforeEach } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

// FeatureManager.gatewayRef is a static, process-wide field other test files
// (e.g. sidecar-agent.test.js) mutate via setGatewayRef() without resetting -
// reset it here so these tests' expectations of the default gateway don't
// depend on which other test files already ran in this process.
beforeEach(() => {
  FeatureManager.gatewayRef = null;
});

const ORIGINAL_ENV = { ...process.env };
function withEnv(vars, fn) {
  Object.assign(process.env, vars);
  return fn().finally(() => {
    process.env = { ...ORIGINAL_ENV };
  });
}

describe('ProvidersFeature createRoute flag', () => {
  test('single-provider mode still creates an HTTPRoute by default (unchanged behavior)', () =>
    withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
      const docs = await FeatureManager.deploy(
        'providers',
        { namespace: 'agentgateway-system', providers: [{ name: 'openai', model: 'gpt-4o-mini' }] },
        { dryRun: true }
      );
      expect(findDoc(docs, 'HTTPRoute', 'openai')).toBeTruthy();
    }));

  test('createRoute: false skips the per-provider HTTPRoute but still creates the backend+secret', () =>
    withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
      const docs = await FeatureManager.deploy(
        'providers',
        {
          namespace: 'agentgateway-system',
          createRoute: false,
          providers: [
            { name: 'routing-dynamic-fast', providerName: 'openai', model: 'gpt-4o-mini' },
          ],
        },
        { dryRun: true }
      );
      expect(findDoc(docs, 'HTTPRoute', 'routing-dynamic-fast')).toBeFalsy();
      const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'routing-dynamic-fast');
      expect(backend).toBeTruthy();
      expect(backend.spec.ai.provider.openai.model).toBe('gpt-4o-mini');
    }));

  test('createRoute: false on groups mode skips the groups HTTPRoute', () =>
    withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
      const docs = await FeatureManager.deploy(
        'providers',
        {
          namespace: 'agentgateway-system',
          createRoute: false,
          groups: [
            {
              providers: [
                { name: 'routing-fallback-cheap', providerName: 'openai', model: 'gpt-4o-mini' },
              ],
            },
            {
              providers: [
                { name: 'routing-fallback-premium', providerName: 'openai', model: 'gpt-4o' },
              ],
            },
          ],
        },
        { dryRun: true }
      );
      expect(findDoc(docs, 'HTTPRoute', 'providers-groups')).toBeFalsy();
    }));

  test('groups mode providers get the default auth.secretRef wiring, matching single-provider mode', () =>
    withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
      const docs = await FeatureManager.deploy(
        'providers',
        {
          namespace: 'agentgateway-system',
          name: 'routing-fallback',
          groups: [
            {
              providers: [
                { name: 'routing-fallback-cheap', providerName: 'openai', model: 'gpt-4o-mini' },
              ],
            },
            {
              providers: [
                { name: 'routing-fallback-premium', providerName: 'openai', model: 'gpt-4o' },
              ],
            },
          ],
        },
        { dryRun: true }
      );
      const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'routing-fallback');
      for (const group of backend.spec.ai.groups) {
        for (const provider of group.providers) {
          expect(provider.policies.auth.secretRef.name).toBe('openai-secret');
        }
      }
    }));

  test('groups mode respects an explicit provider-level auth policy instead of the default', () =>
    withEnv({}, async () => {
      const docs = await FeatureManager.deploy(
        'providers',
        {
          namespace: 'agentgateway-system',
          name: 'routing-fallback',
          groups: [
            {
              providers: [
                {
                  name: 'custom',
                  providerName: 'openai-compatible',
                  model: 'local-model',
                  host: 'local-llm.internal',
                  port: 8080,
                },
              ],
            },
          ],
        },
        { dryRun: true }
      );
      const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'routing-fallback');
      expect(backend.spec.ai.groups[0].providers[0].policies?.auth).toBeUndefined();
    }));

  test('groups mode name override renames the backend (default stays providers-groups)', () =>
    withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
      const defaultNamed = await FeatureManager.deploy(
        'providers',
        {
          namespace: 'agentgateway-system',
          groups: [{ providers: [{ name: 'a', providerName: 'openai', model: 'gpt-4o-mini' }] }],
        },
        { dryRun: true }
      );
      expect(
        findDoc(defaultNamed, 'EnterpriseAgentgatewayBackend', 'providers-groups')
      ).toBeTruthy();

      const customNamed = await FeatureManager.deploy(
        'providers',
        {
          namespace: 'agentgateway-system',
          name: 'routing-fallback',
          groups: [{ providers: [{ name: 'a', providerName: 'openai', model: 'gpt-4o-mini' }] }],
        },
        { dryRun: true }
      );
      expect(
        findDoc(customNamed, 'EnterpriseAgentgatewayBackend', 'routing-fallback')
      ).toBeTruthy();
      expect(findDoc(customNamed, 'EnterpriseAgentgatewayBackend', 'providers-groups')).toBeFalsy();
    }));

  test('body-routing mode (routing-by-name shape) still creates its HTTPRoute with createRoute unset', () =>
    withEnv({ OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
      const docs = await FeatureManager.deploy(
        'providers',
        {
          namespace: 'agentgateway-system',
          bodyRouting: true,
          pathPrefix: '/chat/by-name',
          providers: [
            { name: 'routing-by-name-openai', providerName: 'openai', model: 'gpt-4o-mini' },
            {
              name: 'routing-by-name-anthropic',
              providerName: 'anthropic',
              model: 'claude-3-5-sonnet-20241022',
            },
          ],
        },
        { dryRun: true }
      );
      expect(findDoc(docs, 'HTTPRoute', 'providers-chat-by-name-route')).toBeTruthy();
      expect(findDoc(docs, 'EnterpriseAgentgatewayBackend', 'routing-by-name-openai')).toBeTruthy();
      expect(
        findDoc(docs, 'EnterpriseAgentgatewayBackend', 'routing-by-name-anthropic')
      ).toBeTruthy();
    }));

  test('policies.http is passed through to the backend (e.g. forcing HTTP1 for WebSocket upgrades)', () =>
    withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
      const docs = await FeatureManager.deploy(
        'providers',
        {
          namespace: 'agentgateway-system',
          providers: [
            {
              name: 'openai',
              model: 'gpt-realtime-1.5',
              policies: { http: { version: 'HTTP1' } },
            },
          ],
        },
        { dryRun: true }
      );
      const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'openai');
      expect(backend.spec.policies.http).toEqual({ version: 'HTTP1' });
    }));
});

describe('ProvidersFeature typesafe provider', () => {
  test('typesafe provider defaults host/port/path/model and emits a BackendTLSPolicy', () =>
    withEnv({ TYPESAFE_API_KEY: 'test-typesafe-key' }, async () => {
      const docs = await FeatureManager.deploy(
        'providers',
        {
          namespace: 'agentgateway-system',
          providers: [{ name: 'jev', providerName: 'typesafe', pathPrefix: '/jev' }],
        },
        { dryRun: true }
      );
      const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'jev');
      expect(backend.spec.ai.provider.openai.model).toBe('jev-latest');
      expect(backend.spec.ai.provider.host).toBe('api.typesafe.ai');
      expect(backend.spec.ai.provider.port).toBe(443);
      expect(backend.spec.ai.provider.path).toBe('/v1/systemone');

      const tlsPolicy = findDoc(docs, 'BackendTLSPolicy', 'jev-tls');
      expect(tlsPolicy).toBeTruthy();
      expect(tlsPolicy.spec.validation.hostname).toBe('api.typesafe.ai');
      expect(tlsPolicy.spec.targetRefs[0]).toMatchObject({
        kind: 'EnterpriseAgentgatewayBackend',
        name: 'jev',
      });
    }));

  test('typesafe provider accepts an overridden model name and host', () =>
    withEnv({ TYPESAFE_API_KEY: 'test-typesafe-key' }, async () => {
      const docs = await FeatureManager.deploy(
        'providers',
        {
          namespace: 'agentgateway-system',
          providers: [
            {
              name: 'jev',
              providerName: 'typesafe',
              pathPrefix: '/jev',
              model: 'jev-v2',
              host: 'jev-custom.typesafe.ai',
            },
          ],
        },
        { dryRun: true }
      );
      const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'jev');
      expect(backend.spec.ai.provider.openai.model).toBe('jev-v2');
      expect(backend.spec.ai.provider.host).toBe('jev-custom.typesafe.ai');

      const tlsPolicy = findDoc(docs, 'BackendTLSPolicy', 'jev-tls');
      expect(tlsPolicy.spec.validation.hostname).toBe('jev-custom.typesafe.ai');
    }));

  test('missing TYPESAFE_API_KEY is reported as a required env var for a real (non-dry-run) deploy', async () => {
    // Construct the feature directly and call deploy() on it, instead of going through
    // FeatureManager.deploy(..., {}) - that wrapper's non-dry-run path runs
    // KubernetesHelper.ensureNamespace() (a real kubectl call) before feature.deploy()
    // ever runs, so it needs a reachable, authenticated cluster just to reach this
    // assertion. Calling feature.deploy() directly skips that pre-flight entirely: the
    // env var check is the first thing deploySingleProviders() does, and it throws
    // before any secret/backend/route is applied.
    const savedKey = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const { ProvidersFeature } = await import('../../features/providers/index.js');
      const feature = new ProvidersFeature('providers', {
        namespace: 'agentgateway-system',
        providers: [{ name: 'jev', providerName: 'typesafe', pathPrefix: '/jev' }],
      });
      await expect(feature.deploy()).rejects.toThrow(/TYPESAFE_API_KEY/);
    } finally {
      if (savedKey !== undefined) process.env.TYPESAFE_API_KEY = savedKey;
    }
  });
});

import { test, expect, describe, beforeEach } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';
import { ProvidersFeature } from '../../features/providers/index.js';

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

describe('ProvidersFeature typesafe provider type (Jev)', () => {
  test('applies api.typesafe.ai defaults and a jev-latest model when none given', () =>
    withEnv({ TYPESAFE_API_KEY: 'ts-test' }, async () => {
      const docs = await FeatureManager.deploy(
        'providers',
        {
          namespace: 'agentgateway-system',
          providers: [{ name: 'jev', providerName: 'typesafe', pathPrefix: '/jev' }],
        },
        { dryRun: true }
      );
      const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'jev');
      expect(backend.spec.ai.provider.host).toBe('api.typesafe.ai');
      expect(backend.spec.ai.provider.port).toBe(443);
      expect(backend.spec.ai.provider.path).toBe('/v1/systemone');
      expect(backend.spec.ai.provider.openai.model).toBe('jev-latest');
    }));

  test('getRequiredEnvVars falls through to TYPESAFE_API_KEY for the typesafe provider type', () => {
    const feature = new ProvidersFeature('providers', {
      namespace: 'agentgateway-system',
      providers: [],
    });
    expect(feature.getRequiredEnvVars({ name: 'jev', providerName: 'typesafe' })).toEqual([
      'TYPESAFE_API_KEY',
    ]);
  });

  test('creates a BackendTLSPolicy targeting the typesafe backend with the right hostname', () =>
    withEnv({ TYPESAFE_API_KEY: 'ts-test' }, async () => {
      const docs = await FeatureManager.deploy(
        'providers',
        {
          namespace: 'agentgateway-system',
          providers: [{ name: 'jev', providerName: 'typesafe', pathPrefix: '/jev' }],
        },
        { dryRun: true }
      );
      const tlsPolicy = findDoc(docs, 'BackendTLSPolicy', 'jev-tls');
      expect(tlsPolicy).toBeTruthy();
      expect(tlsPolicy.spec.targetRefs[0]).toEqual({
        group: 'enterpriseagentgateway.solo.io',
        kind: 'EnterpriseAgentgatewayBackend',
        name: 'jev',
      });
      expect(tlsPolicy.spec.validation).toEqual({
        hostname: 'api.typesafe.ai',
        wellKnownCACertificates: 'System',
      });
    }));
});

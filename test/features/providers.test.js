import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

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
          providers: [{ name: 'routing-dynamic-fast', providerName: 'openai', model: 'gpt-4o-mini' }],
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
            { providers: [{ name: 'routing-fallback-cheap', providerName: 'openai', model: 'gpt-4o-mini' }] },
            { providers: [{ name: 'routing-fallback-premium', providerName: 'openai', model: 'gpt-4o' }] },
          ],
        },
        { dryRun: true }
      );
      expect(findDoc(docs, 'HTTPRoute', 'providers-groups')).toBeFalsy();
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
      expect(findDoc(defaultNamed, 'EnterpriseAgentgatewayBackend', 'providers-groups')).toBeTruthy();

      const customNamed = await FeatureManager.deploy(
        'providers',
        {
          namespace: 'agentgateway-system',
          name: 'routing-fallback',
          groups: [{ providers: [{ name: 'a', providerName: 'openai', model: 'gpt-4o-mini' }] }],
        },
        { dryRun: true }
      );
      expect(findDoc(customNamed, 'EnterpriseAgentgatewayBackend', 'routing-fallback')).toBeTruthy();
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
            { name: 'routing-by-name-anthropic', providerName: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
          ],
        },
        { dryRun: true }
      );
      expect(findDoc(docs, 'HTTPRoute', 'providers-chat-by-name-route')).toBeTruthy();
      expect(findDoc(docs, 'EnterpriseAgentgatewayBackend', 'routing-by-name-openai')).toBeTruthy();
      expect(findDoc(docs, 'EnterpriseAgentgatewayBackend', 'routing-by-name-anthropic')).toBeTruthy();
    }));
});

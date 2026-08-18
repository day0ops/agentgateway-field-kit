import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';
import { McpEnterpriseFeature } from '../../features/mcp-enterprise/index.js';

const baseConfig = {
  namespace: 'agentgateway-system',
  backendName: 'mcp-ent-backend',
  targets: [{ name: 'upstream', host: 'upstream.svc.cluster.local', port: 80 }],
};

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('McpEnterpriseFeature auth option', () => {
  test('omitting auth leaves spec.policies unset', async () => {
    const docs = await FeatureManager.deploy('mcp-enterprise', baseConfig, { dryRun: true });
    const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'mcp-ent-backend');
    expect(backend.spec.policies).toBeUndefined();
  });

  test('auth emits spec.policies.auth.secretRef/location.header.name', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-enterprise',
      {
        ...baseConfig,
        auth: { secretRef: { name: 'upstream-token', key: 'token' }, header: 'X-Test-Token' },
      },
      { dryRun: true }
    );
    const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'mcp-ent-backend');
    expect(backend.spec.policies.auth).toEqual({
      secretRef: { name: 'upstream-token', key: 'token' },
      location: { header: { name: 'X-Test-Token' } },
    });
  });

  test('validate() throws when auth is missing header', () => {
    const feature = new McpEnterpriseFeature('mcp-enterprise', {
      ...baseConfig,
      auth: { secretRef: { name: 'upstream-token' } },
    });
    expect(() => feature.validate()).toThrow(/auth requires header/);
  });

  test('validate() throws when auth has neither secretRef nor value/valueEnvVar', () => {
    const feature = new McpEnterpriseFeature('mcp-enterprise', {
      ...baseConfig,
      auth: { header: 'X-Test-Token' },
    });
    expect(() => feature.validate()).toThrow(/auth requires secretRef, or value\/valueEnvVar/);
  });

  test('auth.value creates a Secret and references it', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-enterprise',
      { ...baseConfig, auth: { value: 'super-secret', header: 'X-Test-Token' } },
      { dryRun: true }
    );
    const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'mcp-ent-backend');
    expect(backend.spec.policies.auth.secretRef).toEqual({
      name: 'mcp-ent-backend-auth-secret',
      key: 'token',
    });
    const secret = findDoc(docs, 'Secret', 'mcp-ent-backend-auth-secret');
    expect(secret.stringData.token).toBe('<set auth.value>');
  });

  test('auth.valueEnvVar reads from the environment when creating the Secret', async () => {
    process.env.TEST_MCP_ENTERPRISE_AUTH_TOKEN = 'from-env';
    try {
      const docs = await FeatureManager.deploy(
        'mcp-enterprise',
        {
          ...baseConfig,
          auth: { valueEnvVar: 'TEST_MCP_ENTERPRISE_AUTH_TOKEN', header: 'X-Test-Token' },
        },
        { dryRun: true }
      );
      expect(findDoc(docs, 'Secret', 'mcp-ent-backend-auth-secret')).toBeTruthy();
    } finally {
      delete process.env.TEST_MCP_ENTERPRISE_AUTH_TOKEN;
    }
  });

  test('an existing secretRef is referenced directly - no Secret is created', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-enterprise',
      {
        ...baseConfig,
        auth: { secretRef: { name: 'existing-secret', key: 'secret' }, header: 'X-Test-Token' },
      },
      { dryRun: true }
    );
    expect(docs.some(d => d.includes('kind: Secret'))).toBe(false);
    const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'mcp-ent-backend');
    expect(backend.spec.policies.auth.secretRef).toEqual({
      name: 'existing-secret',
      key: 'secret',
    });
  });
});

describe('McpEnterpriseFeature wellKnownPaths option', () => {
  test('defaults to only matching pathPrefix', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-enterprise',
      { ...baseConfig, pathPrefix: '/mcp' },
      { dryRun: true }
    );
    const route = findDoc(docs, 'HTTPRoute', 'mcp-ent');
    expect(route.spec.rules[0].matches).toEqual([{ path: { type: 'PathPrefix', value: '/mcp' } }]);
  });

  test('wellKnownPaths adds the discovery paths alongside pathPrefix', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-enterprise',
      { ...baseConfig, pathPrefix: '/mcp', wellKnownPaths: true },
      { dryRun: true }
    );
    const route = findDoc(docs, 'HTTPRoute', 'mcp-ent');
    expect(route.spec.rules[0].matches).toEqual([
      { path: { type: 'PathPrefix', value: '/mcp' } },
      { path: { type: 'PathPrefix', value: '/.well-known/oauth-protected-resource/mcp' } },
      { path: { type: 'PathPrefix', value: '/.well-known/oauth-authorization-server/mcp' } },
    ]);
  });

  test('wellKnownPaths without pathPrefix has no effect (route already matches all paths)', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-enterprise',
      { ...baseConfig, wellKnownPaths: true },
      { dryRun: true }
    );
    const route = findDoc(docs, 'HTTPRoute', 'mcp-ent');
    expect(route.spec.rules[0].matches).toBeUndefined();
  });
});

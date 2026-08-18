import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const config = {
  namespace: 'agentgateway-system',
  auth0Domain: 'dev-123456.us.auth0.com',
  audience: 'https://agentgateway.example.test/mcp',
};

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('McpEagerAuthAuth0Feature required config', () => {
  test('requires auth0Domain even during dry-run', async () => {
    await expect(
      FeatureManager.deploy('mcp-eager-auth-auth0', { audience: config.audience }, { dryRun: true })
    ).rejects.toThrow(/requires auth0Domain/);
  });

  test('requires audience even during dry-run', async () => {
    await expect(
      FeatureManager.deploy(
        'mcp-eager-auth-auth0',
        { auth0Domain: config.auth0Domain },
        { dryRun: true }
      )
    ).rejects.toThrow(/requires audience/);
  });

  test('deploys with no clientId at all - real DCR relies on the gateway not short-circuiting it', async () => {
    const docs = await FeatureManager.deploy('mcp-eager-auth-auth0', config, { dryRun: true });
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'mcp-eager-auth-auth0');
    expect(policy.spec.traffic.jwtAuthentication.mcp.clientId).toBeUndefined();
  });

  test('deploys no controller/Postgres/oauth-issuer resources - the gateway handles the exchange directly', async () => {
    const docs = await FeatureManager.deploy('mcp-eager-auth-auth0', config, { dryRun: true });
    const kinds = docs.map(d => yaml.load(d).kind);
    expect(kinds).not.toContain('Deployment');
    expect(kinds).not.toContain('PersistentVolumeClaim');
    expect(findDoc(docs, 'HTTPRoute', 'oauth-issuer')).toBeUndefined();
    expect(findDoc(docs, 'AgentgatewayBackend', 'oauth-issuer-backend')).toBeUndefined();
  });
});

describe('McpEagerAuthAuth0Feature Auth0-specific shape', () => {
  test('issuer has a trailing slash (opposite of Okta)', async () => {
    const docs = await FeatureManager.deploy('mcp-eager-auth-auth0', config, { dryRun: true });
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'mcp-eager-auth-auth0');
    expect(policy.spec.traffic.jwtAuthentication.providers[0].issuer).toBe(
      'https://dev-123456.us.auth0.com/'
    );
    expect(policy.spec.traffic.jwtAuthentication.mcp.provider).toBe('Auth0');
  });

  test('jwksPath is the standard well-known jwks.json', async () => {
    const docs = await FeatureManager.deploy('mcp-eager-auth-auth0', config, { dryRun: true });
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'mcp-eager-auth-auth0');
    expect(policy.spec.traffic.jwtAuthentication.providers[0].jwks.remote.jwksPath).toBe(
      '.well-known/jwks.json'
    );
  });

  test('audiences default to [audience] and are overridable', async () => {
    const docs = await FeatureManager.deploy('mcp-eager-auth-auth0', config, { dryRun: true });
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'mcp-eager-auth-auth0');
    expect(policy.spec.traffic.jwtAuthentication.providers[0].audiences).toEqual([config.audience]);

    const docsOverride = await FeatureManager.deploy(
      'mcp-eager-auth-auth0',
      { ...config, audiences: ['https://custom.example/mcp'] },
      { dryRun: true }
    );
    const policyOverride = findDoc(
      docsOverride,
      'EnterpriseAgentgatewayPolicy',
      'mcp-eager-auth-auth0'
    );
    expect(policyOverride.spec.traffic.jwtAuthentication.providers[0].audiences).toEqual([
      'https://custom.example/mcp',
    ]);
  });

  test('resourceMetadata is a flat map (matches the CRD schema and mcp-eager-auth-okta)', async () => {
    const docs = await FeatureManager.deploy('mcp-eager-auth-auth0', config, { dryRun: true });
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'mcp-eager-auth-auth0');
    const rm = policy.spec.traffic.jwtAuthentication.mcp.resourceMetadata;
    expect(rm.resource).toBe('http://localhost:8080/mcp');
    expect(rm.scopesSupported).toEqual(['openid']);
    expect(rm.bearerMethodsSupported).toEqual(['header', 'body', 'query']);
  });

  test('config.resource overrides the default', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-eager-auth-auth0',
      { ...config, resource: 'https://gw.example.test:8443/mcp' },
      { dryRun: true }
    );
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'mcp-eager-auth-auth0');
    expect(policy.spec.traffic.jwtAuthentication.mcp.resourceMetadata.resource).toBe(
      'https://gw.example.test:8443/mcp'
    );
  });

  test('discovery HTTPRoute carries the MCP path plus both well-known discovery paths, with CORS', async () => {
    const docs = await FeatureManager.deploy('mcp-eager-auth-auth0', config, { dryRun: true });
    const route = findDoc(docs, 'HTTPRoute', 'mcp');
    const paths = route.spec.rules[0].matches.map(m => m.path.value);
    expect(paths).toEqual([
      '/mcp',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server/mcp',
    ]);
    expect(route.spec.rules[0].filters[0].type).toBe('CORS');
  });
});

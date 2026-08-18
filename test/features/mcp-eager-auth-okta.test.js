import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const config = {
  namespace: 'agentgateway-system',
  oktaDomain: 'dev-123456.okta.com',
};

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('McpEagerAuthOktaFeature required config', () => {
  test('requires oktaDomain even during dry-run', async () => {
    await expect(
      FeatureManager.deploy('mcp-eager-auth-okta', {}, { dryRun: true })
    ).rejects.toThrow(/requires oktaDomain/);
  });

  test('does not require clientId during dry-run (discovery/401 structure is still useful without real creds)', async () => {
    await expect(
      FeatureManager.deploy(
        'mcp-eager-auth-okta',
        { oktaDomain: config.oktaDomain },
        { dryRun: true }
      )
    ).resolves.toBeTruthy();
  });

  test('requires clientId for a real (non-dry-run) deploy', async () => {
    // Construct the feature directly and call deploy() on it, instead of going through
    // FeatureManager.deploy(..., {}) - that wrapper's non-dry-run path runs
    // KubernetesHelper.ensureNamespace() (a real kubectl call) before feature.deploy()
    // ever runs, so it needs a reachable, authenticated cluster just to reach this
    // assertion. Calling feature.deploy() directly skips that pre-flight entirely: the
    // clientId check is the first thing this feature's deploy() does after the oktaDomain
    // check, and it throws before any of deployOktaJwksBackend()/etc. apply anything.
    //
    // Also isolate from the ambient OKTA_ISSUER_CLIENT_ID env var - CLAUDE.md tells
    // developers to export it globally, which would otherwise satisfy the clientId
    // getter's fallback and let this deploy past the guard clause.
    const savedClientId = process.env.OKTA_ISSUER_CLIENT_ID;
    delete process.env.OKTA_ISSUER_CLIENT_ID;
    try {
      const { McpEagerAuthOktaFeature } =
        await import('../../features/mcp-eager-auth-okta/index.js');
      const feature = new McpEagerAuthOktaFeature('mcp-eager-auth-okta', config);
      await expect(feature.deploy()).rejects.toThrow(/requires clientId/);
    } finally {
      if (savedClientId !== undefined) process.env.OKTA_ISSUER_CLIENT_ID = savedClientId;
    }
  });

  test('deploys no controller/Postgres/oauth-issuer resources - the gateway handles the exchange directly', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-eager-auth-okta',
      { ...config, clientId: 'test-client-id' },
      { dryRun: true }
    );
    const kinds = docs.map(d => yaml.load(d).kind);
    expect(kinds).not.toContain('Deployment');
    expect(kinds).not.toContain('PersistentVolumeClaim');
    expect(findDoc(docs, 'HTTPRoute', 'oauth-issuer')).toBeUndefined();
    expect(findDoc(docs, 'AgentgatewayBackend', 'oauth-issuer-backend')).toBeUndefined();
  });
});

describe('McpEagerAuthOktaFeature Okta-specific shape', () => {
  test('the JWKS path has no leading slash (Okta-specific, opposite of Entra)', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-eager-auth-okta',
      { ...config, clientId: 'test-client-id' },
      { dryRun: true }
    );
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'mcp-eager-auth-okta');
    expect(policy.spec.traffic.jwtAuthentication.providers[0].jwks.remote.jwksPath).toBe(
      'oauth2/default/v1/keys'
    );
    expect(policy.spec.traffic.jwtAuthentication.providers[0].issuer).toBe(
      'https://dev-123456.okta.com/oauth2/default'
    );
    expect(policy.spec.traffic.jwtAuthentication.mcp.provider).toBe('Okta');
  });

  test('resourceMetadata carries no issuer-proxy pointer - the built-in adapter, not a controller broker', async () => {
    // Regression guard: an earlier controller-brokered design pointed resourceMetadata
    // at the gateway controller's own OAuth issuer (port 7777), but the controller's
    // resource index (resource_index.go) only reads the deprecated `backend.mcp.
    // authentication` field, never `traffic.jwtAuthentication.mcp` - so every real
    // /oauth-issuer/authorize request 400s with "invalid authorization request"
    // (live-verified). Omitting `agentgateway.dev/issuer-proxy` keeps this on
    // agentgateway's own built-in adapter instead, matching mcp-eager-auth-entra.
    const docs = await FeatureManager.deploy(
      'mcp-eager-auth-okta',
      { ...config, clientId: 'test-client-id' },
      { dryRun: true }
    );
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'mcp-eager-auth-okta');
    expect(
      policy.spec.traffic.jwtAuthentication.mcp.resourceMetadata['agentgateway.dev/issuer-proxy']
    ).toBeUndefined();
    expect(
      policy.spec.traffic.jwtAuthentication.mcp.resourceMetadata.authorizationServers
    ).toBeUndefined();
  });

  test('resourceMetadata is a flat map (matches the CRD schema and mcp-eager-auth-auth0)', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-eager-auth-okta',
      { ...config, clientId: 'test-client-id' },
      { dryRun: true }
    );
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'mcp-eager-auth-okta');
    const rm = policy.spec.traffic.jwtAuthentication.mcp.resourceMetadata;
    expect(rm.resource).toBe('http://localhost:8080/mcp');
    expect(rm.scopesSupported).toEqual(['openid']);
    expect(rm.bearerMethodsSupported).toEqual(['header']);
  });

  test('config.resource overrides the default', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-eager-auth-okta',
      { ...config, clientId: 'test-client-id', resource: 'https://gw.example.test:8443/mcp' },
      { dryRun: true }
    );
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'mcp-eager-auth-okta');
    expect(policy.spec.traffic.jwtAuthentication.mcp.resourceMetadata.resource).toBe(
      'https://gw.example.test:8443/mcp'
    );
  });

  test('config.mcpPath overrides the default resource path suffix', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-eager-auth-okta',
      { ...config, clientId: 'test-client-id', mcpPath: '/custom-mcp' },
      { dryRun: true }
    );
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'mcp-eager-auth-okta');
    expect(policy.spec.traffic.jwtAuthentication.mcp.resourceMetadata.resource).toBe(
      'http://localhost:8080/custom-mcp'
    );
  });

  test('default targetRefs point at the mcp-server default HTTPRoute', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-eager-auth-okta',
      { ...config, clientId: 'test-client-id' },
      { dryRun: true }
    );
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'mcp-eager-auth-okta');
    expect(policy.spec.targetRefs).toEqual([
      {
        group: 'gateway.networking.k8s.io',
        kind: 'HTTPRoute',
        name: 'mcp',
      },
    ]);
  });

  test('discovery HTTPRoute carries the MCP path plus both well-known discovery paths, with CORS', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-eager-auth-okta',
      { ...config, clientId: 'test-client-id' },
      { dryRun: true }
    );
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

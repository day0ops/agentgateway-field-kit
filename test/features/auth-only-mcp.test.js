import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const config = {
  namespace: 'agentgateway-system',
  gatewayBaseUrl: 'http://gw.example.test:8080',
};

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('AuthOnlyMcpFeature', () => {
  test('deploys without requiring any config (Keycloak defaults + repo-known client secret)', async () => {
    await expect(
      FeatureManager.deploy('auth-only-mcp', config, { dryRun: true })
    ).resolves.toBeTruthy();
  });

  test('wires KGW_OAUTH_ISSUER_CONFIG with Keycloak as the downstream_server', async () => {
    const docs = await FeatureManager.deploy('auth-only-mcp', config, { dryRun: true });
    const helmDoc = docs.find(d => d.includes('KGW_OAUTH_ISSUER_CONFIG'));
    const oauthConfigMatch = helmDoc.match(/KGW_OAUTH_ISSUER_CONFIG: '(.+)'/);
    const oauthConfig = JSON.parse(oauthConfigMatch[1]);
    expect(oauthConfig.downstream_server.name).toBe('keycloak');
    expect(oauthConfig.downstream_server.client_id).toBe('agw-issuer');
    expect(oauthConfig.downstream_server.authorize_url).toBe(
      'https://keycloak.keycloak.svc.cluster.local/realms/agw-dev/protocol/openid-connect/auth'
    );
    expect(oauthConfig.downstream_server.token_url).toBe(
      'https://keycloak.keycloak.svc.cluster.local/realms/agw-dev/protocol/openid-connect/token'
    );
    expect(oauthConfig.gateway_config.base_url).toBe('http://gw.example.test:8080/oauth-issuer');
  });

  test('the MCP auth policy has no clientId - real DCR is proxied, not mocked', async () => {
    const docs = await FeatureManager.deploy('auth-only-mcp', config, { dryRun: true });
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'auth-only-mcp');
    expect(policy.spec.traffic.jwtAuthentication.mcp.clientId).toBeUndefined();
    expect(policy.spec.traffic.jwtAuthentication.mcp.provider).toBe('Keycloak');
  });

  test('the JWKS path matches Keycloak conventions (no leading slash)', async () => {
    const docs = await FeatureManager.deploy('auth-only-mcp', config, { dryRun: true });
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'auth-only-mcp');
    expect(policy.spec.traffic.jwtAuthentication.providers[0].jwks.remote.jwksPath).toBe(
      'realms/agw-dev/protocol/openid-connect/certs'
    );
    expect(policy.spec.traffic.jwtAuthentication.providers[0].issuer).toBe(
      'https://keycloak.keycloak.svc.cluster.local/realms/agw-dev'
    );
  });

  test('resourceMetadata carries the issuer-proxy pointing at the controller', async () => {
    const docs = await FeatureManager.deploy('auth-only-mcp', config, { dryRun: true });
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'auth-only-mcp');
    expect(
      policy.spec.traffic.jwtAuthentication.mcp.resourceMetadata['agentgateway.dev/issuer-proxy']
    ).toBe(
      'http://enterprise-agentgateway.agentgateway-system.svc.cluster.local:7777/oauth-issuer'
    );
  });

  test('authorizationServers matches gateway_config.base_url exactly (RFC 8414 issuer consistency)', async () => {
    const docs = await FeatureManager.deploy('auth-only-mcp', config, { dryRun: true });
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'auth-only-mcp');
    const helmDoc = docs.find(d => d.includes('KGW_OAUTH_ISSUER_CONFIG'));
    const oauthConfig = JSON.parse(helmDoc.match(/KGW_OAUTH_ISSUER_CONFIG: '(.+)'/)[1]);
    expect(policy.spec.traffic.jwtAuthentication.mcp.resourceMetadata.authorizationServers).toEqual(
      [oauthConfig.gateway_config.base_url]
    );
  });

  test('config.mcpPath overrides the default resource path suffix', async () => {
    const docs = await FeatureManager.deploy(
      'auth-only-mcp',
      { ...config, mcpPath: '/custom-mcp' },
      { dryRun: true }
    );
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'auth-only-mcp');
    expect(policy.spec.traffic.jwtAuthentication.mcp.resourceMetadata.resource).toBe(
      'http://gw.example.test:8080/custom-mcp'
    );
  });

  test('default targetRefs point at the mcp-server default HTTPRoute', async () => {
    const docs = await FeatureManager.deploy('auth-only-mcp', config, { dryRun: true });
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'auth-only-mcp');
    expect(policy.spec.targetRefs).toEqual([
      {
        group: 'gateway.networking.k8s.io',
        kind: 'HTTPRoute',
        name: 'mcp',
      },
    ]);
  });

  test('composes the shared oauth-issuer-route feature (same resources as mcp-eager-auth-okta)', async () => {
    const docs = await FeatureManager.deploy('auth-only-mcp', config, { dryRun: true });
    const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'oauth-issuer-backend');
    const route = findDoc(docs, 'HTTPRoute', 'oauth-issuer');
    expect(backend.spec.static.port).toBe(7777);
    expect(route.spec.rules[0].matches).toEqual([
      { path: { type: 'PathPrefix', value: '/oauth-issuer' } },
    ]);
  });

  describe('with keycloak.externalUrl set (real deploy shape)', () => {
    const externalConfig = {
      ...config,
      keycloak: { externalUrl: 'https://keycloak.demo.example.com' },
    };

    test('issuer and downstream_server URLs use the external hostname, not the in-cluster Service DNS name', async () => {
      const docs = await FeatureManager.deploy('auth-only-mcp', externalConfig, { dryRun: true });
      const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'auth-only-mcp');
      expect(policy.spec.traffic.jwtAuthentication.providers[0].issuer).toBe(
        'https://keycloak.demo.example.com/realms/agw-dev'
      );

      const helmDoc = docs.find(d => d.includes('KGW_OAUTH_ISSUER_CONFIG'));
      const oauthConfig = JSON.parse(helmDoc.match(/KGW_OAUTH_ISSUER_CONFIG: '(.+)'/)[1]);
      expect(oauthConfig.downstream_server.authorize_url).toBe(
        'https://keycloak.demo.example.com/realms/agw-dev/protocol/openid-connect/auth'
      );
      expect(oauthConfig.downstream_server.token_url).toBe(
        'https://keycloak.demo.example.com/realms/agw-dev/protocol/openid-connect/token'
      );
    });

    test('the JWKS backend dials the external hostname with a matching SNI, no insecureSkipVerify', async () => {
      const docs = await FeatureManager.deploy('auth-only-mcp', externalConfig, { dryRun: true });
      const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'auth-only-mcp-jwks');
      expect(backend.spec.static.host).toBe('keycloak.demo.example.com');
      expect(backend.spec.policies.tls).toEqual({ sni: 'keycloak.demo.example.com' });
    });
  });
});

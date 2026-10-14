import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('ElicitationBackendFeature policy shape', () => {
  test('uses entTokenExchange.solo.elicitation, not the deprecated tokenExchange.mode field', async () => {
    const docs = await FeatureManager.deploy(
      'elicitation-backend',
      {
        namespace: 'agentgateway-system',
        backendName: 'github-mcp-backend',
        policyName: 'github-mcp-elicitation',
        routeName: 'mcp-github',
        pathPrefix: '/mcp-github',
        secretName: 'ops-agents-github-oauth',
        provider: 'github',
        clientId: 'placeholder',
        scopes: ['read:user', 'repo'],
        redirectUri: 'https://soloui.example.com/age/elicitations',
        upstream: { host: 'api.githubcopilot.com', port: 443, tls: true },
      },
      { dryRun: true }
    );

    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'github-mcp-elicitation');
    expect(policy).toBeTruthy();
    expect(policy.spec.backend.entTokenExchange).toEqual({ solo: { elicitation: {} } });
    expect(policy.spec.backend.tokenExchange).toBeUndefined();
  });

  test('backend is a proper mcp.targets[] MCP backend, not a bare static backend', async () => {
    const docs = await FeatureManager.deploy(
      'elicitation-backend',
      {
        namespace: 'agentgateway-system',
        backendName: 'github-mcp-backend',
        secretName: 'ops-agents-github-oauth',
        provider: 'github',
        clientId: 'placeholder',
        redirectUri: 'https://soloui.example.com/age/elicitations',
        upstream: { host: 'api.githubcopilot.com', port: 443, tls: true },
      },
      { dryRun: true }
    );

    const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'github-mcp-backend');
    expect(backend).toBeTruthy();
    expect(backend.spec.static).toBeUndefined();
    expect(backend.spec.mcp.targets[0].static.host).toBe('api.githubcopilot.com');
    expect(backend.spec.mcp.targets[0].static.protocol).toBe('StreamableHTTP');
    expect(backend.spec.mcp.targets[0].static.path).toBe('/mcp/');
  });

  test('mode: brokered emits entElicitation.brokered instead of .interactive', async () => {
    const docs = await FeatureManager.deploy(
      'elicitation-backend',
      {
        namespace: 'agentgateway-system',
        backendName: 'stripe-mcp-backend',
        policyName: 'stripe-mcp-elicitation',
        routeName: 'mcp-stripe',
        pathPrefix: '/mcp-stripe',
        mode: 'brokered',
        brokered: {
          mcpResourcePath: '/mcp/stripe',
          chainedAuth: {
            baseUrl: 'https://mcp.stripe.com',
            scopes: ['mcp'],
          },
        },
        upstream: { host: 'mcp.stripe.com', port: 443, tls: true },
      },
      { dryRun: true }
    );

    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'stripe-mcp-elicitation');
    expect(policy).toBeTruthy();
    expect(policy.spec.backend.entElicitation.interactive).toBeUndefined();
    expect(policy.spec.backend.entElicitation.brokered.mcpResourcePath).toBe('/mcp/stripe');
    expect(policy.spec.backend.entElicitation.brokered.chainedAuth.oauth.baseUrl).toBe(
      'https://mcp.stripe.com'
    );
    expect(policy.spec.backend.entElicitation.brokered.chainedAuth.oauth.scopes).toEqual(['mcp']);
  });

  test('mode: interactive (or omitted) still emits the existing .interactive.oauth shape (regression)', async () => {
    const baseConfig = {
      namespace: 'agentgateway-system',
      backendName: 'github-mcp-backend',
      policyName: 'github-mcp-elicitation',
      routeName: 'mcp-github',
      pathPrefix: '/mcp-github',
      secretName: 'ops-agents-github-oauth',
      provider: 'github',
      clientId: 'placeholder',
      scopes: ['read:user', 'repo'],
      redirectUri: 'https://soloui.example.com/age/elicitations',
      upstream: { host: 'api.githubcopilot.com', port: 443, tls: true },
    };

    for (const mode of [undefined, 'interactive']) {
      const docs = await FeatureManager.deploy(
        'elicitation-backend',
        mode === undefined ? baseConfig : { ...baseConfig, mode },
        { dryRun: true }
      );

      const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'github-mcp-elicitation');
      expect(policy).toBeTruthy();
      expect(policy.spec.backend.entElicitation.brokered).toBeUndefined();
      expect(policy.spec.backend.entElicitation.interactive.oauth).toEqual({
        clientId: 'placeholder',
        clientSecretRef: { name: 'ops-agents-github-oauth' },
        scopes: ['read:user', 'repo'],
        redirectUri: 'https://soloui.example.com/age/elicitations',
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        accessTokenUrl: 'https://github.com/login/oauth/access_token',
      });
      expect(policy.spec.backend.entTokenExchange).toEqual({ solo: { elicitation: {} } });
    }
  });
});

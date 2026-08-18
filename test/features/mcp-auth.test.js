import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const baseConfig = {
  namespace: 'agentgateway-system',
  backendName: 'mcp-backend',
  keycloak: {
    realm: 'agw-dev',
    serviceName: 'keycloak',
    serviceNamespace: 'keycloak',
    servicePort: 443,
    configureDynamicRegistration: false,
  },
};

function docsByKind(yamlDocs, kind) {
  return yamlDocs.map(d => yaml.load(d)).filter(d => d.kind === kind);
}

describe('McpAuthFeature edition branching', () => {
  test('enterprise (default, no edition option) emits EnterpriseAgentgatewayPolicy with traffic.jwtAuthentication targeting the HTTPRoute', async () => {
    const docs = await FeatureManager.deploy('mcp-auth', baseConfig, { dryRun: true });
    const policies = docsByKind(docs, 'EnterpriseAgentgatewayPolicy');
    const mcpPolicy = policies.find(p => p.metadata.name === 'mcp-auth');

    expect(mcpPolicy.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(mcpPolicy.spec.targetRefs).toEqual([
      {
        group: 'gateway.networking.k8s.io',
        kind: 'HTTPRoute',
        name: 'mcp',
      },
    ]);
    const jwtAuth = mcpPolicy.spec.traffic.jwtAuthentication;
    expect(jwtAuth.mode).toBe('Strict');
    expect(jwtAuth.mcp.provider).toBe('Keycloak');
    expect(jwtAuth.providers[0].jwks.remote.backendRef.name).toBe('keycloak');
    expect(jwtAuth.mcp.resourceMetadata).toBeDefined();

    const tlsPolicy = policies.find(p => p.metadata.name === 'keycloak-backend-tls');
    expect(tlsPolicy.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(tlsPolicy.spec.backend.tls.insecureSkipVerify).toBe('All');
  });

  test('edition: enterprise resolves identically to omitting the edition option', async () => {
    const withoutEdition = await FeatureManager.deploy('mcp-auth', baseConfig, { dryRun: true });
    const withEnterprise = await FeatureManager.deploy('mcp-auth', baseConfig, {
      dryRun: true,
      edition: 'enterprise',
    });
    expect(withoutEdition).toEqual(withEnterprise);
  });

  test('edition: opensource emits AgentgatewayPolicy with traffic.jwtAuthentication + nested mcp block, targeting the HTTPRoute', async () => {
    const docs = await FeatureManager.deploy('mcp-auth', baseConfig, {
      dryRun: true,
      edition: 'opensource',
    });
    const policies = docsByKind(docs, 'AgentgatewayPolicy');
    expect(docsByKind(docs, 'EnterpriseAgentgatewayPolicy')).toEqual([]);

    const mcpPolicy = policies.find(p => p.metadata.name === 'mcp-auth');
    expect(mcpPolicy.apiVersion).toBe('agentgateway.dev/v1alpha1');
    expect(mcpPolicy.spec.targetRefs).toEqual([
      { group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'mcp' },
    ]);
    const jwtAuth = mcpPolicy.spec.traffic.jwtAuthentication;
    expect(jwtAuth.mode).toBe('Strict');
    expect(jwtAuth.providers[0].issuer).toContain('/realms/agw-dev');
    expect(jwtAuth.providers[0].jwks.remote.backendRef).toEqual({
      name: 'keycloak',
      kind: 'Service',
      namespace: 'keycloak',
      port: 443,
    });
    expect(jwtAuth.providers[0].jwks.remote.jwksPath).toBe(
      '/realms/agw-dev/protocol/openid-connect/certs'
    );
    expect(jwtAuth.mcp.provider).toBe('Keycloak');
    expect(jwtAuth.mcp.resourceMetadata.resource).toBe('http://localhost:8080/mcp');

    const tlsPolicy = policies.find(p => p.metadata.name === 'keycloak-backend-tls');
    expect(tlsPolicy.apiVersion).toBe('agentgateway.dev/v1alpha1');
    expect(tlsPolicy.spec.backend.tls.insecureSkipVerify).toBe('All');
  });
});

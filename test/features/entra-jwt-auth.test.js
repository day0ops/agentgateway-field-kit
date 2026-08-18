import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const config = {
  namespace: 'agentgateway-system',
  tenantId: '11111111-1111-1111-1111-111111111111',
  clientId: '22222222-2222-2222-2222-222222222222',
};

function policyDoc(docs) {
  return docs.map(d => yaml.load(d)).find(d => d.metadata.name === 'entra-jwt-auth');
}

function backendDoc(docs) {
  return docs.map(d => yaml.load(d)).find(d => d.metadata.name === 'entra-jwks');
}

describe('EntraJwtAuthFeature', () => {
  test('requires tenantId', async () => {
    await expect(
      FeatureManager.deploy('entra-jwt-auth', { clientId: config.clientId }, { dryRun: true })
    ).rejects.toThrow(/requires tenantId/);
  });

  test('requires clientId unless audiences is set explicitly', async () => {
    await expect(
      FeatureManager.deploy('entra-jwt-auth', { tenantId: config.tenantId }, { dryRun: true })
    ).rejects.toThrow(/requires clientId/);

    await expect(
      FeatureManager.deploy(
        'entra-jwt-auth',
        { tenantId: config.tenantId, audiences: ['api://custom'] },
        { dryRun: true }
      )
    ).resolves.toBeTruthy();
  });

  test('emits the v1 issuer, leading-slash JWKS path, and default api://<clientId> audience', async () => {
    const docs = await FeatureManager.deploy('entra-jwt-auth', config, { dryRun: true });
    const policy = policyDoc(docs);
    expect(policy.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(policy.kind).toBe('EnterpriseAgentgatewayPolicy');
    const provider = policy.spec.traffic.jwtAuthentication.providers[0];
    expect(provider.issuer).toBe(`https://sts.windows.net/${config.tenantId}/`);
    expect(provider.audiences).toEqual([`api://${config.clientId}`]);
    expect(provider.jwks.remote.jwksPath).toBe(`/${config.tenantId}/discovery/v2.0/keys`);
    expect(provider.jwks.remote.backendRef).toEqual({
      group: 'enterpriseagentgateway.solo.io',
      kind: 'EnterpriseAgentgatewayBackend',
      name: 'entra-jwks',
      namespace: 'agentgateway-system',
    });
    const backend = backendDoc(docs);
    expect(backend.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(backend.kind).toBe('EnterpriseAgentgatewayBackend');
  });

  test('the JWKS backend points at login.microsoftonline.com with no tunnel by default', async () => {
    const docs = await FeatureManager.deploy('entra-jwt-auth', config, { dryRun: true });
    const backend = backendDoc(docs);
    expect(backend.spec.static).toEqual({ host: 'login.microsoftonline.com', port: 443 });
    expect(backend.spec.policies).toEqual({ tls: { sni: 'login.microsoftonline.com' } });
  });

  test('tunnelBackendRef adds policies.tunnel.backendRef, keeping tls.sni intact', async () => {
    const docs = await FeatureManager.deploy(
      'entra-jwt-auth',
      {
        ...config,
        tunnelBackendRef: {
          group: 'agentgateway.dev',
          kind: 'AgentgatewayBackend',
          name: 'corporate-proxy',
          port: 3128,
        },
      },
      { dryRun: true }
    );
    const backend = backendDoc(docs);
    expect(backend.spec.policies.tls).toEqual({ sni: 'login.microsoftonline.com' });
    expect(backend.spec.policies.tunnel.backendRef).toEqual({
      group: 'agentgateway.dev',
      kind: 'AgentgatewayBackend',
      name: 'corporate-proxy',
      port: 3128,
    });
  });

  test('edition: opensource emits AgentgatewayPolicy targeting the opensource default Gateway', async () => {
    const docs = await FeatureManager.deploy('entra-jwt-auth', config, {
      dryRun: true,
      edition: 'opensource',
    });
    const policy = policyDoc(docs);
    expect(policy.apiVersion).toBe('agentgateway.dev/v1alpha1');
    expect(policy.kind).toBe('AgentgatewayPolicy');
    expect(policy.spec.targetRefs[0]).toEqual({
      group: 'gateway.networking.k8s.io',
      kind: 'Gateway',
      name: 'agentgateway-oss-gw',
    });
    const backend = backendDoc(docs);
    expect(backend.apiVersion).toBe('agentgateway.dev/v1alpha1');
    expect(backend.kind).toBe('AgentgatewayBackend');
  });
});

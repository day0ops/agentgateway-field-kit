import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const config = {
  namespace: 'agentgateway-system',
  oktaDomain: 'dev-123456.okta.com',
};

function policyDoc(docs) {
  return docs.map(d => yaml.load(d)).find(d => d.metadata.name === 'okta-jwt-auth');
}

function backendDoc(docs) {
  return docs.map(d => yaml.load(d)).find(d => d.metadata.name === 'okta-jwks');
}

describe('OktaJwtAuthFeature edition branching', () => {
  test('enterprise (default) emits EnterpriseAgentgatewayPolicy targeting the enterprise default Gateway', async () => {
    const docs = await FeatureManager.deploy('okta-jwt-auth', config, { dryRun: true });
    const policy = policyDoc(docs);
    expect(policy.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(policy.kind).toBe('EnterpriseAgentgatewayPolicy');
    expect(policy.spec.targetRefs[0]).toEqual({
      group: 'gateway.networking.k8s.io',
      kind: 'Gateway',
      name: 'agentgateway-gw',
    });
    expect(policy.spec.traffic.jwtAuthentication.providers[0].issuer).toBe(
      'https://dev-123456.okta.com/oauth2/default'
    );
    const backend = backendDoc(docs);
    expect(backend.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(backend.kind).toBe('EnterpriseAgentgatewayBackend');
    expect(policy.spec.traffic.jwtAuthentication.providers[0].jwks.remote.backendRef).toEqual({
      group: 'enterpriseagentgateway.solo.io',
      kind: 'EnterpriseAgentgatewayBackend',
      name: 'okta-jwks',
      namespace: 'agentgateway-system',
    });
  });

  test('edition: enterprise resolves identically to omitting the edition option', async () => {
    const withoutEdition = await FeatureManager.deploy('okta-jwt-auth', config, { dryRun: true });
    const withEnterprise = await FeatureManager.deploy('okta-jwt-auth', config, {
      dryRun: true,
      edition: 'enterprise',
    });
    expect(withoutEdition).toEqual(withEnterprise);
  });

  test('edition: opensource emits AgentgatewayPolicy with the same traffic.jwtAuthentication shape', async () => {
    const docs = await FeatureManager.deploy('okta-jwt-auth', config, {
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
    expect(policy.spec.traffic.phase).toBe('PreRouting');
    expect(policy.spec.traffic.jwtAuthentication.mode).toBe('Strict');
    expect(policy.spec.traffic.jwtAuthentication.providers[0].jwks.remote.backendRef.name).toBe(
      'okta-jwks'
    );
    expect(policy.spec.traffic.transformation.request.set).toEqual([
      { name: 'x-gw-org-id', value: "jwt['org_id']" },
      { name: 'x-gw-team-id', value: "jwt['team_id']" },
    ]);
    const backend = backendDoc(docs);
    expect(backend.apiVersion).toBe('agentgateway.dev/v1alpha1');
    expect(backend.kind).toBe('AgentgatewayBackend');
  });
});

describe('OktaJwtAuthFeature tunnelBackendRef', () => {
  test('omitting tunnelBackendRef leaves the JWKS backend policies unchanged (no tunnel field)', async () => {
    const docs = await FeatureManager.deploy('okta-jwt-auth', config, { dryRun: true });
    const backend = backendDoc(docs);
    expect(backend.spec.policies).toEqual({ tls: { sni: 'dev-123456.okta.com' } });
  });

  test('setting tunnelBackendRef adds policies.tunnel.backendRef, keeping tls.sni intact', async () => {
    const docs = await FeatureManager.deploy(
      'okta-jwt-auth',
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
    expect(backend.spec.policies.tls).toEqual({ sni: 'dev-123456.okta.com' });
    expect(backend.spec.policies.tunnel.backendRef).toEqual({
      group: 'agentgateway.dev',
      kind: 'AgentgatewayBackend',
      name: 'corporate-proxy',
      port: 3128,
    });
  });
});

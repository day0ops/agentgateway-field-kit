import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const config = {
  namespace: 'agentgateway-system',
  keycloakHost: 'keycloak.demo.example.com',
};

function policyDoc(docs) {
  return docs.map(d => yaml.load(d)).find(d => d.metadata.name === 'keycloak-jwt-auth');
}

function backendDoc(docs) {
  return docs.map(d => yaml.load(d)).find(d => d.metadata.name === 'keycloak-jwks');
}

describe('KeycloakJwtAuthFeature edition branching', () => {
  test('enterprise (default) emits EnterpriseAgentgatewayPolicy targeting the enterprise default Gateway', async () => {
    const docs = await FeatureManager.deploy('keycloak-jwt-auth', config, { dryRun: true });
    const policy = policyDoc(docs);
    expect(policy.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(policy.kind).toBe('EnterpriseAgentgatewayPolicy');
    expect(policy.spec.targetRefs[0]).toEqual({
      group: 'gateway.networking.k8s.io',
      kind: 'Gateway',
      name: 'agentgateway-gw',
    });
    expect(policy.spec.traffic.jwtAuthentication.providers[0].issuer).toBe(
      'https://keycloak.demo.example.com/realms/agw-dev'
    );
    const backend = backendDoc(docs);
    expect(backend.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(backend.kind).toBe('EnterpriseAgentgatewayBackend');
    expect(policy.spec.traffic.jwtAuthentication.providers[0].jwks.remote.backendRef).toEqual({
      group: 'enterpriseagentgateway.solo.io',
      kind: 'EnterpriseAgentgatewayBackend',
      name: 'keycloak-jwks',
      namespace: 'agentgateway-system',
    });
  });

  test('edition: enterprise resolves identically to omitting the edition option', async () => {
    const withoutEdition = await FeatureManager.deploy('keycloak-jwt-auth', config, {
      dryRun: true,
    });
    const withEnterprise = await FeatureManager.deploy('keycloak-jwt-auth', config, {
      dryRun: true,
      edition: 'enterprise',
    });
    expect(withoutEdition).toEqual(withEnterprise);
  });

  test('edition: opensource emits AgentgatewayPolicy with the same traffic.jwtAuthentication shape', async () => {
    const docs = await FeatureManager.deploy('keycloak-jwt-auth', config, {
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
    expect(policy.spec.traffic.jwtAuthentication.providers[0].jwks.remote.backendRef.name).toBe(
      'keycloak-jwks'
    );
    expect(policy.spec.traffic.transformation.request.set).toEqual([
      { name: 'x-gw-org-id', value: "jwt['org_id']" },
      { name: 'x-gw-team-id', value: "jwt['team_id']" },
    ]);
    const backend = backendDoc(docs);
    expect(backend.apiVersion).toBe('agentgateway.dev/v1alpha1');
    expect(backend.kind).toBe('AgentgatewayBackend');
  });

  test('explicit targetRefs scope enforcement to a specific HTTPRoute instead of the Gateway', async () => {
    const docs = await FeatureManager.deploy(
      'keycloak-jwt-auth',
      {
        ...config,
        targetRefs: [{ kind: 'HTTPRoute', name: 'providers-chat-route' }],
      },
      { dryRun: true }
    );
    const policy = policyDoc(docs);
    expect(policy.spec.targetRefs).toEqual([
      {
        group: 'gateway.networking.k8s.io',
        kind: 'HTTPRoute',
        name: 'providers-chat-route',
      },
    ]);
  });

  test('default Gateway targeting sets traffic.phase: PreRouting', async () => {
    const docs = await FeatureManager.deploy('keycloak-jwt-auth', config, { dryRun: true });
    const policy = policyDoc(docs);
    expect(policy.spec.traffic.phase).toBe('PreRouting');
  });

  test('HTTPRoute targeting omits traffic.phase (invalid on a non-Gateway target)', async () => {
    const docs = await FeatureManager.deploy(
      'keycloak-jwt-auth',
      {
        ...config,
        targetRefs: [{ kind: 'HTTPRoute', name: 'providers-chat-route' }],
      },
      { dryRun: true }
    );
    const policy = policyDoc(docs);
    expect(policy.spec.traffic.phase).toBeUndefined();
  });

  test('mode defaults to Strict and is configurable', async () => {
    const strict = policyDoc(
      await FeatureManager.deploy('keycloak-jwt-auth', config, { dryRun: true })
    );
    expect(strict.spec.traffic.jwtAuthentication.mode).toBe('Strict');

    const optional = policyDoc(
      await FeatureManager.deploy(
        'keycloak-jwt-auth',
        { ...config, mode: 'Optional' },
        { dryRun: true }
      )
    );
    expect(optional.spec.traffic.jwtAuthentication.mode).toBe('Optional');
  });

  test('claimHeaders fallback coalesces with the JWT claim for callers with no JWT at all', async () => {
    const docs = await FeatureManager.deploy(
      'keycloak-jwt-auth',
      {
        ...config,
        claimHeaders: [
          { claim: 'preferred_username', header: 'x-user-id', fallback: "apiKey['user_id']" },
        ],
      },
      { dryRun: true }
    );
    const policy = policyDoc(docs);
    expect(policy.spec.traffic.transformation.request.set).toEqual([
      { name: 'x-user-id', value: "coalesce(jwt['preferred_username'], apiKey['user_id'])" },
    ]);
  });
});

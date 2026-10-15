import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const targetRefs = [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'mcp' }];

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('OboTokenExchangeFeature single-provider default (unchanged)', () => {
  test('one provider, built from the top-level issuer/jwksPath/jwksBackend/audiences', async () => {
    const docs = await FeatureManager.deploy(
      'obo-token-exchange',
      {
        namespace: 'agentgateway-system',
        policyName: 'single-provider-policy',
        issuer: 'https://sts.example.com',
        jwksPath: '/.well-known/jwks.json',
        jwksBackend: { name: 'sts', namespace: 'agentgateway-system', port: 7777 },
        audiences: ['agentgateway'],
        targetRefs,
      },
      { dryRun: true }
    );

    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'single-provider-policy');
    const providers = policy.spec.traffic.jwtAuthentication.providers;
    expect(providers).toHaveLength(1);
    expect(providers[0]).toEqual({
      issuer: 'https://sts.example.com',
      audiences: ['agentgateway'],
      jwks: {
        remote: {
          jwksPath: '/.well-known/jwks.json',
          cacheDuration: '5m',
          backendRef: {
            group: '',
            kind: 'Service',
            name: 'sts',
            namespace: 'agentgateway-system',
            port: 7777,
          },
        },
      },
    });
  });

  test('omitting audiences leaves the field unset, not an empty array', async () => {
    const docs = await FeatureManager.deploy(
      'obo-token-exchange',
      {
        namespace: 'agentgateway-system',
        policyName: 'no-audiences-policy',
        issuer: 'https://sts.example.com',
        jwksPath: '/.well-known/jwks.json',
        jwksBackend: { name: 'sts', namespace: 'agentgateway-system', port: 7777 },
        targetRefs,
      },
      { dryRun: true }
    );

    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'no-audiences-policy');
    expect(policy.spec.traffic.jwtAuthentication.providers[0].audiences).toBeUndefined();
  });
});

describe('OboTokenExchangeFeature multi-provider (config.providers)', () => {
  test('providers array produces one entry per config, matching spec.traffic.jwtAuthentication.providers', async () => {
    const docs = await FeatureManager.deploy(
      'obo-token-exchange',
      {
        namespace: 'agentgateway-system',
        policyName: 'delegation-jwt-policy',
        targetRefs,
        providers: [
          {
            issuer: 'https://sts.internal/realms/agw-dev',
            jwksPath: '/.well-known/jwks.json',
            jwksBackend: { name: 'enterprise-agentgateway', namespace: 'agentgateway-system', port: 7777 },
            audiences: ['agentgateway'],
          },
          {
            audiences: ['account'],
          },
        ],
      },
      { dryRun: true }
    );

    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'delegation-jwt-policy');
    const providers = policy.spec.traffic.jwtAuthentication.providers;
    expect(providers).toHaveLength(2);

    expect(providers[0]).toEqual({
      issuer: 'https://sts.internal/realms/agw-dev',
      audiences: ['agentgateway'],
      jwks: {
        remote: {
          jwksPath: '/.well-known/jwks.json',
          cacheDuration: '5m',
          backendRef: {
            group: '',
            kind: 'Service',
            name: 'enterprise-agentgateway',
            namespace: 'agentgateway-system',
            port: 7777,
          },
        },
      },
    });
  });

  test('a provider entry with no issuer/jwksPath/jwksBackend falls back to the feature defaults (Keycloak)', async () => {
    const docs = await FeatureManager.deploy(
      'obo-token-exchange',
      {
        namespace: 'agentgateway-system',
        policyName: 'delegation-jwt-policy',
        targetRefs,
        providers: [
          {
            issuer: 'https://sts.internal/realms/agw-dev',
            jwksPath: '/.well-known/jwks.json',
            jwksBackend: { name: 'enterprise-agentgateway', namespace: 'agentgateway-system', port: 7777 },
            audiences: ['agentgateway'],
          },
          {
            audiences: ['account'],
          },
        ],
      },
      { dryRun: true }
    );

    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'delegation-jwt-policy');
    const keycloakProvider = policy.spec.traffic.jwtAuthentication.providers[1];
    expect(keycloakProvider).toEqual({
      issuer: 'https://keycloak.keycloak.svc.cluster.local/realms/agw-dev',
      audiences: ['account'],
      jwks: {
        remote: {
          jwksPath: 'realms/agw-dev/protocol/openid-connect/certs',
          cacheDuration: '5m',
          backendRef: {
            group: '',
            kind: 'Service',
            name: 'keycloak',
            namespace: 'keycloak',
            port: 443,
          },
        },
      },
    });
  });

  test('the backend TLS policy for the default Keycloak provider is still applied in multi-provider mode', async () => {
    const docs = await FeatureManager.deploy(
      'obo-token-exchange',
      {
        namespace: 'agentgateway-system',
        policyName: 'delegation-jwt-policy',
        targetRefs,
        providers: [
          {
            issuer: 'https://sts.internal/realms/agw-dev',
            jwksPath: '/.well-known/jwks.json',
            jwksBackend: { name: 'enterprise-agentgateway', namespace: 'agentgateway-system', port: 7777 },
            audiences: ['agentgateway'],
          },
          { audiences: ['account'] },
        ],
      },
      { dryRun: true }
    );

    const tlsPolicy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'keycloak-backend-tls');
    expect(tlsPolicy.spec.backend.tls.insecureSkipVerify).toBe('All');
  });
});

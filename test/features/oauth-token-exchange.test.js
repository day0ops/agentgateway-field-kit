import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const targetRefs = [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'mcp' }];
const baseConfig = {
  namespace: 'agentgateway-system',
  targetRefs,
  jwtAuthentication: {
    issuer: 'http://keycloak.keycloak.svc.cluster.local:8080/realms/agw-dev',
    jwks: {
      host: 'keycloak.keycloak.svc.cluster.local',
      port: 8080,
      path: 'realms/agw-dev/protocol/openid-connect/certs',
      tls: false,
    },
  },
  tokenEndpoint: {
    host: 'keycloak.keycloak.svc.cluster.local',
    port: 8080,
    path: '/realms/agw-dev/protocol/openid-connect/token',
    tls: false,
  },
  clientAuth: { clientId: 'agentgateway-token-exchange' },
};

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('OauthTokenExchangeFeature required config', () => {
  test('requires at least one targetRef, even during dry-run', async () => {
    await expect(
      FeatureManager.deploy(
        'oauth-token-exchange',
        { ...baseConfig, targetRefs: [] },
        { dryRun: true }
      )
    ).rejects.toThrow(/at least one entry in config.targetRefs/);
  });

  test('requires jwtAuthentication.issuer/jwks.host/jwks.path, even during dry-run', async () => {
    await expect(
      FeatureManager.deploy(
        'oauth-token-exchange',
        { ...baseConfig, jwtAuthentication: {} },
        { dryRun: true }
      )
    ).rejects.toThrow(/requires jwtAuthentication/);
  });

  test('requires tokenEndpoint.host/path, even during dry-run', async () => {
    await expect(
      FeatureManager.deploy(
        'oauth-token-exchange',
        { ...baseConfig, tokenEndpoint: {} },
        { dryRun: true }
      )
    ).rejects.toThrow(/requires tokenEndpoint/);
  });

  test('requires a client secret for a real (non-dry-run) deploy', async () => {
    // Construct the feature directly and call deploy() on it, instead of going through
    // FeatureManager.deploy(..., {}) - that wrapper's non-dry-run path runs
    // KubernetesHelper.ensureNamespace() (a real kubectl call) before feature.deploy()
    // ever runs, so it needs a reachable, authenticated cluster just to reach this
    // assertion. Calling feature.deploy() directly skips that pre-flight entirely: the
    // clientSecret check is the first thing this feature's deploy() does after its other
    // config checks, and it throws before deployJwksBackend()/etc. ever apply anything.
    //
    // Also point clientSecretEnvVar at a var guaranteed to be unset, rather than relying
    // on OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET being absent from the shell - it's a real env
    // var this repo documents for live deploys, so when it's set (as it is for anyone
    // actually using this feature), the fallback silently finds a real secret and this
    // test's deploy() would proceed to apply resources instead of throwing.
    const { OauthTokenExchangeFeature } =
      await import('../../features/oauth-token-exchange/index.js');
    const feature = new OauthTokenExchangeFeature('oauth-token-exchange', {
      ...baseConfig,
      clientAuth: { ...baseConfig.clientAuth, clientSecretEnvVar: '__OTE_TEST_UNSET_SECRET__' },
    });
    await expect(feature.deploy()).rejects.toThrow(/requires clientAuth.clientSecret/);
  });
});

describe('OauthTokenExchangeFeature policy shape', () => {
  test('combines traffic.jwtAuthentication and backend.auth.oauthTokenExchange in one policy, matching the verified current (v2026.7.0+) field names', async () => {
    const docs = await FeatureManager.deploy('oauth-token-exchange', baseConfig, {
      dryRun: true,
    });
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'oauth-token-exchange');
    expect(policy.spec.targetRefs).toEqual(targetRefs);

    // Not the early, now-rejected `backend.tokenExchange.oauth` shape.
    expect(policy.spec.backend.tokenExchange).toBeUndefined();
    expect(policy.spec.backend.auth.oauthTokenExchange).toBeTruthy();

    const exchange = policy.spec.backend.auth.oauthTokenExchange;
    expect(exchange.path).toBe('/realms/agw-dev/protocol/openid-connect/token');
    expect(exchange.grantType).toBe('TokenExchange');
    expect(exchange.subjectToken).toEqual({ tokenType: 'AccessToken' });
    expect(exchange.clientAuth).toEqual({
      method: 'ClientSecretBasic',
      clientId: 'agentgateway-token-exchange',
      secretRef: { name: 'oauth-token-exchange-client-secret', key: 'client_secret' },
    });
    expect(exchange.backendRef).toEqual({
      group: 'enterpriseagentgateway.solo.io',
      kind: 'EnterpriseAgentgatewayBackend',
      name: 'oauth-token-exchange-token-endpoint',
    });
  });

  test('no STS/tokenExchange Helm feature is touched - this is proxy-native', async () => {
    const docs = await FeatureManager.deploy('oauth-token-exchange', baseConfig, {
      dryRun: true,
    });
    const helmComment = docs.find(d => d.includes('helm upgrade'));
    expect(helmComment).toBeUndefined();
  });

  test('tokenEndpoint.path without a leading slash is normalized - the CRD requires it to match ^/', async () => {
    const docs = await FeatureManager.deploy(
      'oauth-token-exchange',
      { ...baseConfig, tokenEndpoint: { ...baseConfig.tokenEndpoint, path: 'no-leading-slash' } },
      { dryRun: true }
    );
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'oauth-token-exchange');
    expect(policy.spec.backend.auth.oauthTokenExchange.path).toBe('/no-leading-slash');
  });

  test('jwks.tls: false omits the TLS policy on the JWKS backend (in-cluster plain HTTP)', async () => {
    const docs = await FeatureManager.deploy('oauth-token-exchange', baseConfig, {
      dryRun: true,
    });
    const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'oauth-token-exchange-jwks');
    expect(backend.spec.policies).toBeUndefined();
  });

  test('tls defaults to true when omitted, adding tls.sni (most real IdPs are HTTPS)', async () => {
    const docs = await FeatureManager.deploy(
      'oauth-token-exchange',
      {
        ...baseConfig,
        jwtAuthentication: {
          ...baseConfig.jwtAuthentication,
          jwks: { ...baseConfig.jwtAuthentication.jwks, tls: undefined, host: 'idp.example.com' },
        },
      },
      { dryRun: true }
    );
    const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'oauth-token-exchange-jwks');
    expect(backend.spec.policies).toEqual({ tls: { sni: 'idp.example.com' } });
  });

  test('omitting audiences/scopes/resources/additionalParams leaves them unset', async () => {
    const docs = await FeatureManager.deploy('oauth-token-exchange', baseConfig, {
      dryRun: true,
    });
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'oauth-token-exchange');
    const exchange = policy.spec.backend.auth.oauthTokenExchange;
    expect(exchange.audiences).toBeUndefined();
    expect(exchange.scopes).toBeUndefined();
    expect(exchange.resources).toBeUndefined();
    expect(exchange.additionalParams).toBeUndefined();
  });

  test('grantType: JwtBearer plus scopes/additionalParams supports vendor OBO flows (e.g. Entra)', async () => {
    const docs = await FeatureManager.deploy(
      'oauth-token-exchange',
      {
        ...baseConfig,
        grantType: 'JwtBearer',
        scopes: ['https://graph.microsoft.com/.default'],
        additionalParams: { requested_token_use: '"on_behalf_of"' },
      },
      { dryRun: true }
    );
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'oauth-token-exchange');
    const exchange = policy.spec.backend.auth.oauthTokenExchange;
    expect(exchange.grantType).toBe('JwtBearer');
    expect(exchange.scopes).toEqual(['https://graph.microsoft.com/.default']);
    expect(exchange.additionalParams).toEqual({ requested_token_use: '"on_behalf_of"' });
  });

  test('audiences and resources pass through unchanged', async () => {
    const docs = await FeatureManager.deploy(
      'oauth-token-exchange',
      { ...baseConfig, audiences: ['target-client'], resources: ['https://api.example.com/'] },
      { dryRun: true }
    );
    const policy = findDoc(docs, 'EnterpriseAgentgatewayPolicy', 'oauth-token-exchange');
    const exchange = policy.spec.backend.auth.oauthTokenExchange;
    expect(exchange.audiences).toEqual(['target-client']);
    expect(exchange.resources).toEqual(['https://api.example.com/']);
  });
});

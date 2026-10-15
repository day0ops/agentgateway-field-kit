import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const targetRefs = [
  { group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'wizard-secure' },
];
const baseConfig = {
  namespace: 'agentgateway-system',
  targetRefs,
  clientId: 'agw-ext-auth',
  clientSecret: 'test-secret',
  appUrl: 'https://wizard.example.com',
};

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('OAuthAuthorizationCodeFeature clientSecretEnvVar', () => {
  test('reads the secret from a configured env var name instead of the KEYCLOAK_SECRET default', async () => {
    const original = process.env.TEST_EXT_AUTH_SECRET;
    process.env.TEST_EXT_AUTH_SECRET = 'from-custom-env-var';
    try {
      const docs = await FeatureManager.deploy(
        'oauth-authorization-code',
        {
          namespace: 'agentgateway-system',
          targetRefs,
          clientId: 'agw-ext-auth',
          appUrl: 'https://wizard.example.com',
          clientSecretEnvVar: 'TEST_EXT_AUTH_SECRET',
        },
        { dryRun: true }
      );
      const secret = findDoc(docs, 'Secret', 'oauth-keycloak');
      expect(secret.stringData['client-secret']).toBe('from-custom-env-var');
    } finally {
      if (original === undefined) delete process.env.TEST_EXT_AUTH_SECRET;
      else process.env.TEST_EXT_AUTH_SECRET = original;
    }
  });
});

describe('OAuthAuthorizationCodeFeature access-token forwarding, refresh, and logout', () => {
  test('emits accessTokenHeader and useBearerSchemaForAuthorization when configured', async () => {
    const docs = await FeatureManager.deploy(
      'oauth-authorization-code',
      {
        ...baseConfig,
        headers: { accessTokenHeader: 'Authorization', useBearerSchemaForAuthorization: true },
      },
      { dryRun: true }
    );
    const authConfig = findDoc(docs, 'AuthConfig', 'oauth-authorization-code');
    const oidc = authConfig.spec.configs[0].oauth2.oidcAuthorizationCode;
    expect(oidc.headers.accessTokenHeader).toBe('Authorization');
    expect(oidc.headers.useBearerSchemaForAuthorization).toBe(true);
  });

  test('defaults useBearerSchemaForAuthorization/accessTokenHeader to absent when unset', async () => {
    const docs = await FeatureManager.deploy('oauth-authorization-code', baseConfig, {
      dryRun: true,
    });
    const authConfig = findDoc(docs, 'AuthConfig', 'oauth-authorization-code');
    const oidc = authConfig.spec.configs[0].oauth2.oidcAuthorizationCode;
    expect(oidc.headers.accessTokenHeader).toBeUndefined();
    expect(oidc.headers.useBearerSchemaForAuthorization).toBeUndefined();
    expect(oidc.headers.idTokenHeader).toBe('jwt');
  });

  test('emits session.redis.allowRefreshing and preExpiryBuffer when configured', async () => {
    const docs = await FeatureManager.deploy(
      'oauth-authorization-code',
      { ...baseConfig, session: { allowRefreshing: true, preExpiryBufferSeconds: 30 } },
      { dryRun: true }
    );
    const authConfig = findDoc(docs, 'AuthConfig', 'oauth-authorization-code');
    const oidc = authConfig.spec.configs[0].oauth2.oidcAuthorizationCode;
    expect(oidc.session.redis.allowRefreshing).toBe(true);
    expect(oidc.session.redis.preExpiryBuffer).toBe('30s');
  });

  test('omits allowRefreshing and preExpiryBuffer when unset', async () => {
    const docs = await FeatureManager.deploy('oauth-authorization-code', baseConfig, {
      dryRun: true,
    });
    const authConfig = findDoc(docs, 'AuthConfig', 'oauth-authorization-code');
    const oidc = authConfig.spec.configs[0].oauth2.oidcAuthorizationCode;
    expect(oidc.session.redis.allowRefreshing).toBeUndefined();
    expect(oidc.session.redis.preExpiryBuffer).toBeUndefined();
  });

  test('emits logoutPath when configured', async () => {
    const docs = await FeatureManager.deploy(
      'oauth-authorization-code',
      { ...baseConfig, logoutPath: '/secure/logout' },
      { dryRun: true }
    );
    const authConfig = findDoc(docs, 'AuthConfig', 'oauth-authorization-code');
    const oidc = authConfig.spec.configs[0].oauth2.oidcAuthorizationCode;
    expect(oidc.logoutPath).toBe('/secure/logout');
  });

  test('omits logoutPath when unset', async () => {
    const docs = await FeatureManager.deploy('oauth-authorization-code', baseConfig, {
      dryRun: true,
    });
    const authConfig = findDoc(docs, 'AuthConfig', 'oauth-authorization-code');
    const oidc = authConfig.spec.configs[0].oauth2.oidcAuthorizationCode;
    expect(oidc.logoutPath).toBeUndefined();
  });
});

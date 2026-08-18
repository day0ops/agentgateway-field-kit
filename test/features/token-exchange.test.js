import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

function helmValuesDoc(docs) {
  const doc = docs.find(d => d.includes('Helm upgrade'));
  const withoutComments = doc
    .split('\n')
    .filter(l => !l.trim().startsWith('#'))
    .join('\n');
  return yaml.load(withoutComments);
}

describe('TokenExchangeFeature database.postgres', () => {
  test('omitting database leaves tokenExchange.database unset', async () => {
    const docs = await FeatureManager.deploy('token-exchange', {}, { dryRun: true });
    const values = helmValuesDoc(docs);
    expect(values.tokenExchange.database).toBeUndefined();
  });

  test('config.database.postgres.url maps to tokenExchange.database.postgres.url', async () => {
    const url = 'postgres://user:pass@host:5432/db?sslmode=disable';
    const docs = await FeatureManager.deploy(
      'token-exchange',
      { database: { postgres: { url } } },
      { dryRun: true }
    );
    const values = helmValuesDoc(docs);
    expect(values.tokenExchange.database).toEqual({ type: 'postgres', postgres: { url } });
  });
});

describe('TokenExchangeFeature oauthIssuerConfig', () => {
  test('omitting oauthIssuerConfig leaves controller.extraEnv unset', async () => {
    const docs = await FeatureManager.deploy('token-exchange', {}, { dryRun: true });
    const values = helmValuesDoc(docs);
    expect(values.controller).toBeUndefined();
  });

  test('config.oauthIssuerConfig is JSON-stringified into controller.extraEnv.KGW_OAUTH_ISSUER_CONFIG', async () => {
    const oauthIssuerConfig = {
      downstream_server: { name: 'okta', client_id: 'abc' },
      gateway_config: { base_url: 'http://gw:8080/oauth-issuer' },
    };
    const docs = await FeatureManager.deploy(
      'token-exchange',
      { oauthIssuerConfig },
      { dryRun: true }
    );
    const values = helmValuesDoc(docs);
    expect(JSON.parse(values.controller.extraEnv.KGW_OAUTH_ISSUER_CONFIG)).toEqual(
      oauthIssuerConfig
    );
  });
});

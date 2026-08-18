import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('FrontendMtlsFeature', () => {
  test('issues a client-auth certificate off the gateway-mtls addon default CA issuer', async () => {
    const docs = await FeatureManager.deploy(
      'frontend-mtls',
      { namespace: 'agentgateway-system' },
      { dryRun: true }
    );

    expect(docs.length).toBe(1);
    const clientCert = findDoc(docs, 'Certificate', 'frontend-mtls-client');

    expect(clientCert.spec.usages).toEqual(['client auth']);
    expect(clientCert.spec.secretName).toBe('frontend-mtls-client-secret');
    expect(clientCert.spec.issuerRef).toEqual({
      name: 'gateway-mtls-client-ca-issuer',
      kind: 'Issuer',
    });
  });

  test('config.name prefixes the client certificate and its secret', async () => {
    const docs = await FeatureManager.deploy(
      'frontend-mtls',
      { namespace: 'agentgateway-system', name: 'custom-mtls' },
      { dryRun: true }
    );
    const clientCert = findDoc(docs, 'Certificate', 'custom-mtls-client');
    expect(clientCert.spec.secretName).toBe('custom-mtls-client-secret');
  });

  test('config.caIssuerName overrides the default CA-backed Issuer to issue from', async () => {
    const docs = await FeatureManager.deploy(
      'frontend-mtls',
      { namespace: 'agentgateway-system', caIssuerName: 'other-ca-issuer' },
      { dryRun: true }
    );
    const clientCert = findDoc(docs, 'Certificate', 'frontend-mtls-client');
    expect(clientCert.spec.issuerRef).toEqual({ name: 'other-ca-issuer', kind: 'Issuer' });
  });
});

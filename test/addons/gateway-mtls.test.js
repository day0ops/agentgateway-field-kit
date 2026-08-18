import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../addons/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('GatewayMtlsFeature dry-run', () => {
  test('builds the CA chain plus delegates the server certificate to the certificate feature', async () => {
    const docs = await FeatureManager.deploy(
      'gateway-mtls',
      { namespace: 'agentgateway-system' },
      { dryRun: true }
    );

    const rootIssuer = findDoc(docs, 'Issuer', 'gateway-mtls-ca-issuer');
    const caCert = findDoc(docs, 'Certificate', 'gateway-mtls-ca');
    const caConfigMap = findDoc(docs, 'ConfigMap', 'gateway-mtls-ca');
    const clientCaIssuer = findDoc(docs, 'Issuer', 'gateway-mtls-client-ca-issuer');
    const serverCert = findDoc(docs, 'Certificate', 'gateway-mtls-server-tls');

    expect(rootIssuer.spec).toEqual({ selfSigned: {} });

    expect(caCert.spec.isCA).toBe(true);
    expect(caCert.spec.secretName).toBe('gateway-mtls-ca-secret');
    expect(caCert.spec.issuerRef).toEqual({ name: 'gateway-mtls-ca-issuer', kind: 'Issuer' });

    expect(caConfigMap.data['ca.crt']).toBeTruthy();

    expect(clientCaIssuer.spec).toEqual({ ca: { secretName: 'gateway-mtls-ca-secret' } });

    expect(serverCert.spec.secretName).toBe('gateway-mtls-server-tls');
    expect(serverCert.spec.issuerRef).toEqual({ name: 'selfsigned-issuer', kind: 'ClusterIssuer' });
    expect(serverCert.spec.dnsNames).toEqual(['gateway-mtls.local']);
  });

  test('config.dnsNames overrides the server certificate DNS names', async () => {
    const docs = await FeatureManager.deploy(
      'gateway-mtls',
      { namespace: 'agentgateway-system', dnsNames: ['agentgateway.example.com'] },
      { dryRun: true }
    );
    const serverCert = findDoc(docs, 'Certificate', 'gateway-mtls-server-tls');
    expect(serverCert.spec.dnsNames).toEqual(['agentgateway.example.com']);
  });

  test('config.name prefixes every resource', async () => {
    const docs = await FeatureManager.deploy(
      'gateway-mtls',
      { namespace: 'agentgateway-system', name: 'custom-mtls' },
      { dryRun: true }
    );
    expect(findDoc(docs, 'Certificate', 'custom-mtls-ca')).toBeTruthy();
    expect(findDoc(docs, 'Issuer', 'custom-mtls-client-ca-issuer')).toBeTruthy();
    expect(findDoc(docs, 'Certificate', 'custom-mtls-server-tls')).toBeTruthy();
  });

  test('publicHttps.enabled issues a second certificate from letsencrypt-dns', async () => {
    const docs = await FeatureManager.deploy(
      'gateway-mtls',
      {
        namespace: 'agentgateway-system',
        publicHttps: { enabled: true, dnsNames: ['agentgateway.example.com'] },
      },
      { dryRun: true }
    );
    const publicCert = findDoc(docs, 'Certificate', 'gateway-public-tls');
    expect(publicCert.spec.secretName).toBe('gateway-public-tls');
    expect(publicCert.spec.issuerRef).toEqual({ name: 'letsencrypt-dns', kind: 'ClusterIssuer' });
    expect(publicCert.spec.dnsNames).toEqual(['agentgateway.example.com']);
  });

  test('publicHttps.issuer overrides the default letsencrypt-dns issuer', async () => {
    const docs = await FeatureManager.deploy(
      'gateway-mtls',
      {
        namespace: 'agentgateway-system',
        publicHttps: { enabled: true, dnsNames: ['agentgateway.example.com'], issuer: 'my-issuer' },
      },
      { dryRun: true }
    );
    const publicCert = findDoc(docs, 'Certificate', 'gateway-public-tls');
    expect(publicCert.spec.issuerRef).toEqual({ name: 'my-issuer', kind: 'ClusterIssuer' });
  });

  test('omitting publicHttps deploys no second certificate', async () => {
    const docs = await FeatureManager.deploy(
      'gateway-mtls',
      { namespace: 'agentgateway-system' },
      { dryRun: true }
    );
    expect(findDoc(docs, 'Certificate', 'gateway-public-tls')).toBeUndefined();
  });
});

import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('CorporateProxyFeature', () => {
  test('defaults: Squid workload in its own namespace, backend in the gateway namespace', async () => {
    const docs = await FeatureManager.deploy(
      'corporate-proxy',
      { namespace: 'agentgateway-system' },
      { dryRun: true }
    );

    const configMap = findDoc(docs, 'ConfigMap', 'corporate-proxy');
    const service = findDoc(docs, 'Service', 'corporate-proxy');
    const deployment = findDoc(docs, 'Deployment', 'corporate-proxy');
    const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'corporate-proxy');

    expect(configMap.metadata.namespace).toBe('corporate-proxy');
    expect(service.metadata.namespace).toBe('corporate-proxy');
    expect(deployment.metadata.namespace).toBe('corporate-proxy');
    expect(backend.metadata.namespace).toBe('agentgateway-system');
    expect(backend.spec.static).toEqual({
      host: 'corporate-proxy.corporate-proxy.svc.cluster.local',
      port: 3128,
    });
  });

  test('squid.conf allows all destinations by default', async () => {
    const docs = await FeatureManager.deploy(
      'corporate-proxy',
      { namespace: 'agentgateway-system' },
      { dryRun: true }
    );
    const configMap = findDoc(docs, 'ConfigMap', 'corporate-proxy');
    expect(configMap.data['squid.conf']).toContain('http_access allow all');
    expect(configMap.data['squid.conf']).not.toContain('dstdomain');
  });

  test('allowedHosts restricts squid.conf to a dstdomain allowlist', async () => {
    const docs = await FeatureManager.deploy(
      'corporate-proxy',
      { namespace: 'agentgateway-system', allowedHosts: ['okta.com', 'login.microsoftonline.com'] },
      { dryRun: true }
    );
    const configMap = findDoc(docs, 'ConfigMap', 'corporate-proxy');
    expect(configMap.data['squid.conf']).toContain(
      'acl allowed_dsts dstdomain okta.com login.microsoftonline.com'
    );
    expect(configMap.data['squid.conf']).toContain('http_access deny all');
  });
});

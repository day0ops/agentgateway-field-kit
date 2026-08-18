import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

describe('GatewayFeature edition-aware defaults', () => {
  test('enterprise (default) uses agentgateway-gw and the enterprise GatewayClass', async () => {
    const docs = await FeatureManager.deploy('gateway', {}, { dryRun: true });
    const gateway = yaml.load(docs[0]);
    expect(gateway.metadata.name).toBe('agentgateway-gw');
    expect(gateway.spec.gatewayClassName).toBe('enterprise-agentgateway');
  });

  test('edition: opensource uses agentgateway-oss-gw and the OSS GatewayClass', async () => {
    const docs = await FeatureManager.deploy(
      'gateway',
      {},
      { dryRun: true, edition: 'opensource' }
    );
    const gateway = yaml.load(docs[0]);
    expect(gateway.metadata.name).toBe('agentgateway-oss-gw');
    expect(gateway.spec.gatewayClassName).toBe('agentgateway');
  });

  test('an explicit config.name/gatewayClassName still overrides the edition default', async () => {
    const docs = await FeatureManager.deploy(
      'gateway',
      { name: 'custom-gateway', gatewayClassName: 'custom-class' },
      { dryRun: true, edition: 'opensource' }
    );
    const gateway = yaml.load(docs[0]);
    expect(gateway.metadata.name).toBe('custom-gateway');
    expect(gateway.spec.gatewayClassName).toBe('custom-class');
  });
});

describe('GatewayFeature tls passthrough', () => {
  test('omitting tls leaves spec.tls unset (no regression for existing use cases)', async () => {
    const docs = await FeatureManager.deploy('gateway', {}, { dryRun: true });
    const gateway = yaml.load(docs[0]);
    expect(gateway.spec.tls).toBeUndefined();
  });

  test('config.tls is passed through unchanged to spec.tls', async () => {
    const tls = {
      frontend: {
        default: {
          validation: {
            mode: 'AllowValidOnly',
            caCertificateRefs: [{ name: 'ca-cert', kind: 'ConfigMap', group: '' }],
          },
        },
      },
    };
    const docs = await FeatureManager.deploy('gateway', { tls }, { dryRun: true });
    const gateway = yaml.load(docs[0]);
    expect(gateway.spec.tls).toEqual(tls);
  });
});

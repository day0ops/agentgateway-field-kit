import { test, expect, describe } from 'bun:test';
import '../../addons/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

describe('OpikFeature dry-run', () => {
  test('does not perform any live helm/kubectl calls and produces a descriptive comment', async () => {
    const docs = await FeatureManager.deploy('opik', {}, { dryRun: true });
    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0]).toContain('helm repo add opik https://comet-ml.github.io/opik/');
    expect(docs[0]).toContain('opik/opik');
    expect(docs[0]).toContain('--namespace opik');
    expect(docs[0]).toContain('--version 2.2.19');
  });

  test('config.chartVersions.opik overrides the pinned version', async () => {
    const docs = await FeatureManager.deploy(
      'opik',
      { chartVersions: { opik: '2.3.0' } },
      { dryRun: true }
    );
    expect(docs[0]).toContain('--version 2.3.0');
  });

  test('config.minioEnabled defaults to false (smaller footprint)', async () => {
    const docs = await FeatureManager.deploy('opik', {}, { dryRun: true });
    expect(docs[0]).toContain('minio.enabled=false');
  });

  test('config.opikNamespace overrides the default opik namespace', async () => {
    const docs = await FeatureManager.deploy(
      'opik',
      { opikNamespace: 'custom-opik' },
      { dryRun: true }
    );
    expect(docs[0]).toContain('--namespace custom-opik');
  });

  test('config.namespace (the generic Feature default) does NOT affect the opik namespace', async () => {
    // Regression guard for the bug this file caught: FeatureManager.deploy() always
    // pre-fills config.namespace, so it must never be read for opikNamespace's default.
    const docs = await FeatureManager.deploy(
      'opik',
      { namespace: 'agentgateway-system' },
      { dryRun: true }
    );
    expect(docs[0]).toContain('--namespace opik');
  });
});

import { test, expect, describe, afterAll } from 'bun:test';
import { mkdtempSync } from 'fs';
import { writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { UseCaseManager } from '../../src/lib/usecase.js';
import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { EnvironmentManager } from '../../src/lib/environment.js';
import { KubernetesHelper } from '../../src/lib/common.js';

class RecordingFeature extends Feature {
  async deploy() {}
  async cleanup() {
    RecordingFeature.cleanedUp.push(this.name);
  }
}
RecordingFeature.cleanedUp = [];
// FeatureManager.features is a static, process-wide Map - registering over the real
// 'certificate' entry here without restoring it corrupts every other test file that
// imports features/index.js afterward (that import is cached and never re-runs, so the
// real CertificateFeature registration never comes back on its own).
const originalFeatures = new Map(FeatureManager.features);
FeatureManager.register('certificate', RecordingFeature);
FeatureManager.register('__test-uc-cert-skip-other', RecordingFeature);

const usecaseYaml =
  `apiVersion: agentgateway.demo/v1\n` +
  `kind: UseCase\n` +
  `metadata:\n` +
  `  name: cert-skip-test\n` +
  `spec:\n` +
  `  features:\n` +
  `    - name: certificate\n` +
  `      config: { name: cert-skip-test-tls }\n` +
  `    - name: __test-uc-cert-skip-other\n`;

describe('UseCaseManager.cleanup certificate skip/force', () => {
  let tmpRoot, originalResolveActive, originalLoad, originalKubectl, originalGatewayRef;

  afterAll(async () => {
    FeatureManager.features = originalFeatures;
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  async function withMocks(fn) {
    originalResolveActive = EnvironmentManager.resolveActive;
    EnvironmentManager.resolveActive = async () => 'local';
    originalLoad = EnvironmentManager.load;
    EnvironmentManager.load = async () => ({});
    originalGatewayRef = FeatureManager.gatewayRef;
    originalKubectl = KubernetesHelper.kubectl;
    KubernetesHelper.kubectl = async args =>
      args[0] === 'get'
        ? { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' };

    try {
      await fn();
    } finally {
      EnvironmentManager.resolveActive = originalResolveActive;
      EnvironmentManager.load = originalLoad;
      KubernetesHelper.kubectl = originalKubectl;
      FeatureManager.gatewayRef = originalGatewayRef;
    }
  }

  test('skips the certificate feature by default', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'uc-cert-skip-'));
    const usecaseFile = join(tmpRoot, 'uc.yaml');
    await writeFile(usecaseFile, usecaseYaml);
    RecordingFeature.cleanedUp = [];

    await withMocks(() => UseCaseManager.cleanup(usecaseFile));

    expect(RecordingFeature.cleanedUp).toEqual(['__test-uc-cert-skip-other']);
  });

  test('cleans up the certificate feature too when force is set', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'uc-cert-skip-'));
    const usecaseFile = join(tmpRoot, 'uc.yaml');
    await writeFile(usecaseFile, usecaseYaml);
    RecordingFeature.cleanedUp = [];

    await withMocks(() => UseCaseManager.cleanup(usecaseFile, { force: true }));

    expect(RecordingFeature.cleanedUp).toEqual(['__test-uc-cert-skip-other', 'certificate']);
  });
});

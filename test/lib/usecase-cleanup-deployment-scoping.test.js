import { test, expect, describe, afterAll } from 'bun:test';
import { mkdtempSync } from 'fs';
import { writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { UseCaseManager } from '../../src/lib/usecase.js';
import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { EnvironmentManager } from '../../src/lib/environment.js';
import { KubernetesHelper } from '../../src/lib/common.js';

// Regression coverage for a real bug: UseCaseManager.cleanup() prefixes deploymentId with
// 'usecase.' at every FeatureManager call, but its merged-policy sweep call was missed and
// passed the bare metadata.name instead - meaning the sweep's deploymentId never matched the
// 'usecase.<name>' label its own deploys actually wrote, and a usecase's own merged policies
// were silently skipped forever. No dedicated test harness exists for
// UseCaseManager.deploy()/cleanup()'s broader orchestration (environment resolution, step/
// diagram display, current-usecase tracking); this test exists specifically to pin the one
// thing that already broke once.

class DummyCleanupScopingFeature extends Feature {
  async deploy() {}
  async cleanup() {}
}
FeatureManager.register('__test-uc-cleanup-scoping', DummyCleanupScopingFeature);

const usecaseYaml =
  `apiVersion: agentgateway.demo/v1\n` +
  `kind: UseCase\n` +
  `metadata:\n` +
  `  name: cleanup-scoping-test\n` +
  `spec:\n` +
  `  features:\n` +
  `    - name: __test-uc-cleanup-scoping\n`;

describe('UseCaseManager.cleanup merged-policy sweep deploymentId', () => {
  let tmpRoot, originalResolveActive, originalLoad, originalKubectl;

  afterAll(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  test("passes the same 'usecase.<name>' prefixed deploymentId to the sweep that its own deploys label resources with", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'uc-cleanup-scoping-'));
    const usecaseFile = join(tmpRoot, 'uc.yaml');
    await writeFile(usecaseFile, usecaseYaml);

    // Skip the real kubectl-context auto-detection - irrelevant here and potentially slow/flaky.
    originalResolveActive = EnvironmentManager.resolveActive;
    EnvironmentManager.resolveActive = async () => 'local';
    originalLoad = EnvironmentManager.load;
    EnvironmentManager.load = async () => ({});

    const getCalls = [];
    const deleteCalls = [];
    originalKubectl = KubernetesHelper.kubectl;
    KubernetesHelper.kubectl = async args => {
      if (args[0] === 'get') {
        getCalls.push(args);
        // Simulate a merged policy this exact usecase previously deployed - labeled by a
        // real (non-test-double) deploy, i.e. with the 'usecase.' prefix.
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            items: [
              {
                metadata: {
                  name: 'merged-some-feature-some-route',
                  annotations: {
                    'agentgateway.dev/contributor-deployments': 'usecase.cleanup-scoping-test',
                  },
                },
              },
            ],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'delete') deleteCalls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    try {
      await UseCaseManager.cleanup(usecaseFile);
    } finally {
      EnvironmentManager.resolveActive = originalResolveActive;
      EnvironmentManager.load = originalLoad;
      KubernetesHelper.kubectl = originalKubectl;
    }

    expect(getCalls.length).toBeGreaterThan(0);
    // The regression: without the 'usecase.' prefix on the sweep's own deploymentId, this
    // merged policy (labeled with the prefix, exactly as a real deploy would) would never be
    // recognized as this usecase's own, and would never be deleted.
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toContain('merged-some-feature-some-route');
  });
});

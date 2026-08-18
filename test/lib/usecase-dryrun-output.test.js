import { test, expect, describe, afterAll } from 'bun:test';
import { mkdtempSync, chmodSync } from 'fs';
import { writeFile, rm, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { UseCaseManager } from '../../src/lib/usecase.js';
import { Feature, FeatureManager } from '../../src/lib/feature.js';

class DummyDryrunOutputFeature extends Feature {
  async deploy() {}
  async cleanup() {}
}

FeatureManager.register('__test-uc-dryrun-output', DummyDryrunOutputFeature);

const usecaseYaml =
  `apiVersion: agentgateway.demo/v1\n` +
  `kind: UseCase\n` +
  `metadata:\n` +
  `  name: dryrun-output-test\n` +
  `spec:\n` +
  `  features:\n` +
  `    - name: __test-uc-dryrun-output\n`;

describe('UseCaseManager.dryRun -o/--output', () => {
  let tmpRoot;

  afterAll(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  test('writes generated YAML to the given file instead of stdout', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'uc-dryrun-output-'));
    const usecaseFile = join(tmpRoot, 'uc.yaml');
    await writeFile(usecaseFile, usecaseYaml);
    const outFile = join(tmpRoot, 'out.yaml');

    await expect(UseCaseManager.dryRun(usecaseFile, { output: outFile })).resolves.toBeUndefined();

    const written = await readFile(outFile, 'utf8');
    expect(written).toContain('Generated YAML for use case: dryrun-output-test');
  });

  test('errors out when the output directory does not exist', async () => {
    const usecaseFile = join(tmpRoot, 'uc.yaml');
    const outFile = join(tmpRoot, 'does-not-exist', 'out.yaml');

    await expect(UseCaseManager.dryRun(usecaseFile, { output: outFile })).rejects.toThrow(
      /Output directory does not exist/
    );
  });

  test('errors out when the output directory is not writable', async () => {
    const usecaseFile = join(tmpRoot, 'uc.yaml');
    const roDir = join(tmpRoot, 'read-only');
    await mkdir(roDir);
    chmodSync(roDir, 0o555);
    const outFile = join(roDir, 'out.yaml');

    try {
      await expect(UseCaseManager.dryRun(usecaseFile, { output: outFile })).rejects.toThrow(
        /Output directory is not writable/
      );
    } finally {
      chmodSync(roDir, 0o755);
    }
  });
});

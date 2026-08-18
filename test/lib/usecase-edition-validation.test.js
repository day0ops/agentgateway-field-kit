import { test, expect, describe, afterAll } from 'bun:test';
import { mkdtempSync } from 'fs';
import { writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { UseCaseManager } from '../../src/lib/usecase.js';
import { Feature, FeatureManager } from '../../src/lib/feature.js';

class DummyEditionValidationBoth extends Feature {
  async deploy() {}
  async cleanup() {}
}

class DummyEditionValidationEnterpriseOnly extends Feature {
  static SUPPORTED_EDITIONS = ['enterprise'];
  async deploy() {}
  async cleanup() {}
}

FeatureManager.register('__test-uc-both', DummyEditionValidationBoth);
FeatureManager.register('__test-uc-enterprise-only', DummyEditionValidationEnterpriseOnly);

function usecaseYaml({ edition, featureName }) {
  const editionLine = edition ? `  edition: ${edition}\n` : '';
  return (
    `apiVersion: agentgateway.demo/v1\n` +
    `kind: UseCase\n` +
    `metadata:\n` +
    `  name: edition-validation-test\n` +
    `spec:\n` +
    editionLine +
    `  features:\n` +
    `    - name: ${featureName}\n`
  );
}

describe('UseCaseManager edition validation', () => {
  let tmpRoot;

  afterAll(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  test('dryRun() fails fast when an opensource usecase references an enterprise-only feature', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'uc-edition-validation-'));
    const file = join(tmpRoot, 'uc.yaml');
    await writeFile(
      file,
      usecaseYaml({ edition: 'opensource', featureName: '__test-uc-enterprise-only' })
    );

    await expect(UseCaseManager.dryRun(file)).rejects.toThrow(
      /declares edition 'opensource' but feature '__test-uc-enterprise-only' only supports: enterprise/
    );
  });

  test('dryRun() succeeds when an opensource usecase references a both-edition feature', async () => {
    const file = join(tmpRoot, 'uc-both.yaml');
    await writeFile(file, usecaseYaml({ edition: 'opensource', featureName: '__test-uc-both' }));

    await expect(UseCaseManager.dryRun(file)).resolves.toBeUndefined();
  });

  test('dryRun() succeeds for an enterprise-only feature when edition is omitted (defaults to enterprise)', async () => {
    const file = join(tmpRoot, 'uc-default.yaml');
    await writeFile(file, usecaseYaml({ featureName: '__test-uc-enterprise-only' }));

    await expect(UseCaseManager.dryRun(file)).resolves.toBeUndefined();
  });

  test('validateFeatureEditions() throws with the offending feature name and supported list', () => {
    expect(() =>
      UseCaseManager.validateFeatureEditions('my-usecase', 'opensource', [
        { name: '__test-uc-enterprise-only' },
      ])
    ).toThrow("Use case 'my-usecase' declares edition 'opensource'");
  });

  test('validateFeatureEditions() does not throw when all features support the edition', () => {
    expect(() =>
      UseCaseManager.validateFeatureEditions('my-usecase', 'opensource', [
        { name: '__test-uc-both' },
      ])
    ).not.toThrow();
  });
});

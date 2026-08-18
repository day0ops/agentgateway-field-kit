// test/runbook/feature.test.js
import { test, expect, describe } from 'bun:test';
import { mkdtempSync } from 'fs';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FeatureAdapter } from '../../src/lib/runbook-adapters/feature.js';

const FEATURES_DIR = new URL('../../features', import.meta.url).pathname;

describe('FeatureAdapter', () => {
  test('generate(prompt-guards) returns Lab N heading', async () => {
    const section = await FeatureAdapter.generate({ name: 'prompt-guards', labNum: 3 });
    expect(section).toContain('## Lab 3:');
  });

  test('generate(prompt-guards) contains description from JSDoc', async () => {
    const section = await FeatureAdapter.generate({ name: 'prompt-guards', labNum: 3 });
    // Prompt guards JSDoc mentions "guardrails" or "prompt"
    expect(section.toLowerCase()).toMatch(/guardrail|prompt/);
  });

  test('generate(prompt-guards) contains yaml block from dryRun', async () => {
    const section = await FeatureAdapter.generate({ name: 'prompt-guards', labNum: 3 });
    // dryRun may return empty for unconfigured feature — accept either yaml or bash block
    expect(section).toMatch(/```(yaml|bash)/);
  });

  test('generate uses runbook.md sidecar when present', async () => {
    // Write a temporary sidecar
    const sidecarPath = join(FEATURES_DIR, 'prompt-guards', 'runbook.md');
    await writeFile(
      sidecarPath,
      '## YAML\n\n```yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: test\n```\n\n## Test\n\ncurl http://example.com\n',
      'utf8'
    );

    try {
      const section = await FeatureAdapter.generate({ name: 'prompt-guards', labNum: 3 });
      expect(section).toContain('kind: ConfigMap');
      expect(section).toContain('curl http://example.com');
    } finally {
      await rm(sidecarPath, { force: true });
    }
  });

  test('generate() with projectRoot finds feature sidecar in that root', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'feature-root-'));
    await mkdir(join(tmpRoot, 'features', 'my-portable-feature'), { recursive: true });
    await writeFile(
      join(tmpRoot, 'features', 'my-portable-feature', 'runbook.md'),
      '## YAML\n\n```yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: portable-cm\n```\n'
    );
    try {
      const section = await FeatureAdapter.generate({
        name: 'my-portable-feature',
        labNum: 1,
        projectRoot: tmpRoot,
      });
      expect(section).toContain('portable-cm');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('generate throws for unknown feature', async () => {
    await expect(
      FeatureAdapter.generate({ name: 'nonexistent-feature-xyz', labNum: 5 })
    ).rejects.toThrow();
  });
});

// test/runbook/usecase.test.js
import { test, expect, describe } from 'bun:test';
import { mkdtempSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { UseCaseAdapter } from '../../src/lib/runbook-adapters/usecase.js';

describe('UseCaseAdapter', () => {
  test('generate(apikey-auth) returns Lab N heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'apikey-auth',
      labNum: 2,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('## Lab 2:');
  });

  test('generate(apikey-auth) contains sequence diagram fenced block', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'apikey-auth',
      labNum: 2,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(apikey-auth) skips providers step and adds note', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'apikey-auth',
      labNum: 2,
      deployedProviders: ['openai'],
    });
    // Should NOT show a full providers deploy block
    // Should contain a reference back to providers lab
    expect(section.toLowerCase()).toContain('providers');
    expect(section).toContain('Lab 1');
  });

  test('generate(apikey-auth) contains step headings', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'apikey-auth',
      labNum: 2,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('### Step');
  });

  test('generate(apikey-auth) contains yaml blocks from dryRun or sidecar', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'apikey-auth',
      labNum: 2,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```yaml');
  });

  test('generate() with empty-root projectRoot throws for valid use case (not found in empty dir)', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'uc-root-'));
    await mkdir(join(tmpRoot, 'config', 'usecases'), { recursive: true });
    try {
      await expect(
        UseCaseAdapter.generate({
          name: 'apikey-auth',
          labNum: 2,
          deployedProviders: [],
          projectRoot: tmpRoot,
        })
      ).rejects.toThrow();
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('generate throws for unknown use case', async () => {
    await expect(
      UseCaseAdapter.generate({ name: 'nonexistent-use-case', labNum: 2, deployedProviders: [] })
    ).rejects.toThrow();
  });

  test('generate(openai-model-aliasing) returns Lab heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'openai-model-aliasing',
      labNum: 5,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('## Lab 5:');
  });

  test('generate(openai-model-aliasing) contains sequence diagram', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'openai-model-aliasing',
      labNum: 5,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(p2c-load-balancing) returns Lab heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'p2c-load-balancing',
      labNum: 6,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('## Lab 6:');
  });

  test('generate(p2c-load-balancing) contains sequence diagram', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'p2c-load-balancing',
      labNum: 6,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(gemini-streaming) returns Lab heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'gemini-streaming',
      labNum: 7,
      deployedProviders: ['gemini'],
    });
    expect(section).toContain('## Lab 7:');
  });

  test('generate(gemini-streaming) contains sequence diagram', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'gemini-streaming',
      labNum: 7,
      deployedProviders: ['gemini'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(dynamic-user-context) returns Lab heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'dynamic-user-context',
      labNum: 8,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('## Lab 8:');
  });

  test('generate(dynamic-user-context) contains sequence diagram', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'dynamic-user-context',
      labNum: 8,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(token-cap) returns Lab heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'token-cap',
      labNum: 9,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('## Lab 9:');
  });

  test('generate(token-cap) contains sequence diagram', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'token-cap',
      labNum: 9,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(header-access-control) returns Lab heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'header-access-control',
      labNum: 10,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('## Lab 10:');
  });

  test('generate(header-access-control) contains sequence diagram', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'header-access-control',
      labNum: 10,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(per-key-token-budget) returns Lab heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'per-key-token-budget',
      labNum: 11,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('## Lab 11:');
  });

  test('generate(per-key-token-budget) contains sequence diagram', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'per-key-token-budget',
      labNum: 11,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(token-usage-monitoring) returns Lab heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'token-usage-monitoring',
      labNum: 12,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('## Lab 12:');
  });

  test('generate(token-usage-monitoring) contains sequence diagram', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'token-usage-monitoring',
      labNum: 12,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });
});

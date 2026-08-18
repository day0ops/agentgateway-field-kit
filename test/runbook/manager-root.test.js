import { test, expect, describe, afterAll, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { ProfileManager } from '../../src/lib/profiles.js';
import { EnvironmentManager } from '../../src/lib/environment.js';
import { UseCaseManager } from '../../src/lib/usecase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../..');

let tmpRoot;

describe('Manager root overrides', () => {
  afterAll(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  test('ProfileManager.list(root) reads profiles from given root', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'runbook-mgr-'));
    await mkdir(join(tmpRoot, 'config', 'profiles'), { recursive: true });
    await writeFile(
      join(tmpRoot, 'config', 'profiles', 'my-test-profile.yaml'),
      'name: my-test-profile\n'
    );
    const profiles = await ProfileManager.list(tmpRoot);
    expect(profiles.find(p => p.name === 'my-test-profile')).toBeDefined();
    // Should NOT include profiles from the real PROFILES_DIR
    const realProfiles = await ProfileManager.list(PROJECT_ROOT);
    expect(realProfiles.find(p => p.name === 'my-test-profile')).toBeUndefined();
  });

  test('EnvironmentManager.list(root) reads environments from given root', async () => {
    const envRoot = mkdtempSync(join(tmpdir(), 'runbook-env-'));
    try {
      await mkdir(join(envRoot, 'config', 'environments'), { recursive: true });
      await writeFile(
        join(envRoot, 'config', 'environments', 'my-test-env.yaml'),
        'metadata:\n  description: test env\n'
      );
      const envs = await EnvironmentManager.list(envRoot);
      expect(envs.find(e => e.name === 'my-test-env')).toBeDefined();
    } finally {
      await rm(envRoot, { recursive: true, force: true });
    }
  });

  test('UseCaseManager.list(root) reads use cases from given root', async () => {
    const ucRoot = mkdtempSync(join(tmpdir(), 'runbook-uc-'));
    try {
      await mkdir(join(ucRoot, 'config', 'usecases'), { recursive: true });
      await writeFile(
        join(ucRoot, 'config', 'usecases', 'my-usecase.yaml'),
        'metadata:\n  name: my-usecase\nspec:\n  steps: []\n'
      );
      const ucs = await UseCaseManager.list(ucRoot);
      expect(ucs.find(u => u.name === 'my-usecase')).toBeDefined();
    } finally {
      await rm(ucRoot, { recursive: true, force: true });
    }
  });

  test('UseCaseManager.get(name, root) finds use case in given root', async () => {
    const ucRoot = mkdtempSync(join(tmpdir(), 'runbook-ucget-'));
    try {
      await mkdir(join(ucRoot, 'config', 'usecases'), { recursive: true });
      await writeFile(
        join(ucRoot, 'config', 'usecases', 'my-usecase.yaml'),
        'metadata:\n  name: my-usecase\nspec:\n  steps: []\n'
      );
      const uc = await UseCaseManager.get('my-usecase', ucRoot);
      expect(uc.name).toBe('my-usecase');
    } finally {
      await rm(ucRoot, { recursive: true, force: true });
    }
  });

  test('ProfileManager.list() with no args returns results from real project directory', async () => {
    const profiles = await ProfileManager.list();
    expect(Array.isArray(profiles)).toBe(true);
    expect(profiles.length).toBeGreaterThan(0);
  });

  test('EnvironmentManager.list() with no args returns results from real project directory', async () => {
    const envs = await EnvironmentManager.list();
    expect(Array.isArray(envs)).toBe(true);
  });

  test('UseCaseManager.list() with no args returns results from real project directory', async () => {
    const ucs = await UseCaseManager.list();
    expect(Array.isArray(ucs)).toBe(true);
    expect(ucs.length).toBeGreaterThan(0);
  });

  test('ProfileManager.list(root) returns [] for nonexistent dir', async () => {
    const result = await ProfileManager.list('/nonexistent/path/that/does/not/exist');
    expect(result).toEqual([]);
  });

  test('EnvironmentManager.list(root) returns [] for nonexistent dir', async () => {
    const result = await EnvironmentManager.list('/nonexistent/path/that/does/not/exist');
    expect(result).toEqual([]);
  });

  test('UseCaseManager.list(root) returns [] for nonexistent dir', async () => {
    const result = await UseCaseManager.list('/nonexistent/path/that/does/not/exist');
    expect(result).toEqual([]);
  });
});

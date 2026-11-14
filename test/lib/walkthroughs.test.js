import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { WalkthroughManager } from '../../src/lib/walkthroughs.js';

class DualEditionFeature extends Feature {
  async deploy() {}
  async cleanup() {}
}

class EnterpriseOnlyFeature extends Feature {
  static SUPPORTED_EDITIONS = ['enterprise'];
  async deploy() {}
  async cleanup() {}
}

let originalFeatures;

beforeEach(() => {
  originalFeatures = FeatureManager.features;
  FeatureManager.features = new Map();
  FeatureManager.register('dual-edition-feature', DualEditionFeature);
  FeatureManager.register('enterprise-only-feature', EnterpriseOnlyFeature);
});

afterEach(() => {
  FeatureManager.features = originalFeatures;
});

describe('WalkthroughManager.list', () => {
  test('lists walkthroughs found under <root>/config/walkthroughs with their descriptions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agw-walkthroughs-test-'));
    const dir = join(root, 'config', 'walkthroughs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'demo.yaml'),
      [
        'apiVersion: agentgateway.demo/v1',
        'kind: Walkthrough',
        'metadata:',
        '  name: demo',
        '  description: A demo walkthrough',
        'spec: { screens: [{ name: one }] }',
        '',
      ].join('\n')
    );
    try {
      const walkthroughs = await WalkthroughManager.list(root);
      expect(walkthroughs.map(w => w.name)).toEqual(['demo']);
      expect(walkthroughs[0].description).toBe('A demo walkthrough');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns an empty array when the directory does not exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agw-walkthroughs-empty-'));
    try {
      expect(await WalkthroughManager.list(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('WalkthroughManager.load', () => {
  test('loads a walkthrough with no environment binding as-is, defaulting optional fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agw-walkthroughs-load-'));
    const filePath = join(root, 'standalone.yaml');
    writeFileSync(
      filePath,
      [
        'apiVersion: agentgateway.demo/v1',
        'kind: Walkthrough',
        'metadata:',
        '  name: standalone',
        'spec:',
        '  screens:',
        '    - name: one',
        '',
      ].join('\n')
    );
    try {
      const walkthrough = await WalkthroughManager.load(filePath);
      expect(walkthrough.screens).toEqual([{ name: 'one' }]);
      expect(walkthrough.credentials).toEqual({});
      expect(walkthrough.preProvision).toEqual([]);
      expect(walkthrough.edition).toBe('enterprise');
      expect(walkthrough.namespace).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves environment templates when spec.environment is set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agw-walkthroughs-env-'));
    const envDir = join(root, 'config', 'environments');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(
      join(envDir, 'test-env.yaml'),
      [
        'apiVersion: agentgateway.demo/v1',
        'kind: Environment',
        'metadata:',
        '  name: test-env',
        'spec:',
        '  domains:',
        '    app:',
        '      demo: demo.example.com',
        '',
      ].join('\n')
    );
    const filePath = join(root, 'walkthrough.yaml');
    writeFileSync(
      filePath,
      [
        'apiVersion: agentgateway.demo/v1',
        'kind: Walkthrough',
        'metadata:',
        '  name: templated',
        'spec:',
        '  environment: test-env',
        '  screens:',
        '    - name: one',
        '      setup:',
        '        - name: dual-edition-feature',
        "          config: { hostname: '{{env.domains.app.demo}}' }",
        '',
      ].join('\n')
    );

    const { EnvironmentManager } = await import('../../src/lib/environment.js');
    const originalDir = EnvironmentManager.ENVIRONMENTS_DIR;
    EnvironmentManager.ENVIRONMENTS_DIR = envDir;

    try {
      const walkthrough = await WalkthroughManager.load(filePath);
      expect(walkthrough.screens[0].setup[0].config.hostname).toBe('demo.example.com');
    } finally {
      EnvironmentManager.ENVIRONMENTS_DIR = originalDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves spec.edition via resolveEdition, defaulting to enterprise', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agw-walkthroughs-edition-'));
    const filePath = join(root, 'opensource.yaml');
    writeFileSync(
      filePath,
      [
        'apiVersion: agentgateway.demo/v1',
        'kind: Walkthrough',
        'metadata:',
        '  name: opensource-walkthrough',
        'spec:',
        '  edition: opensource',
        '  screens:',
        '    - name: one',
        '      setup:',
        '        - name: dual-edition-feature',
        '',
      ].join('\n')
    );
    try {
      const walkthrough = await WalkthroughManager.load(filePath);
      expect(walkthrough.edition).toBe('opensource');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('throws when a setup feature does not support the resolved edition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agw-walkthroughs-bad-edition-'));
    const filePath = join(root, 'bad.yaml');
    writeFileSync(
      filePath,
      [
        'apiVersion: agentgateway.demo/v1',
        'kind: Walkthrough',
        'metadata:',
        '  name: bad-edition-walkthrough',
        'spec:',
        '  edition: opensource',
        '  screens:',
        '    - name: one',
        '      setup:',
        '        - name: enterprise-only-feature',
        '',
      ].join('\n')
    );
    try {
      await expect(WalkthroughManager.load(filePath)).rejects.toThrow(
        /enterprise-only-feature.*only supports/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('throws when a teardown feature does not support the resolved edition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agw-walkthroughs-teardown-edition-'));
    const filePath = join(root, 'bad-teardown.yaml');
    writeFileSync(
      filePath,
      [
        'apiVersion: agentgateway.demo/v1',
        'kind: Walkthrough',
        'metadata:',
        '  name: bad-teardown-walkthrough',
        'spec:',
        '  edition: opensource',
        '  screens:',
        '    - name: one',
        '      teardown:',
        '        - name: enterprise-only-feature',
        '',
      ].join('\n')
    );
    try {
      await expect(WalkthroughManager.load(filePath)).rejects.toThrow(/enterprise-only-feature/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('throws when a preProvision feature does not support the resolved edition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agw-walkthroughs-preProvision-edition-'));
    const filePath = join(root, 'bad-preProvision.yaml');
    writeFileSync(
      filePath,
      [
        'apiVersion: agentgateway.demo/v1',
        'kind: Walkthrough',
        'metadata:',
        '  name: bad-preProvision-walkthrough',
        'spec:',
        '  edition: opensource',
        '  preProvision:',
        '    - name: enterprise-only-feature',
        '  screens:',
        '    - name: one',
        '',
      ].join('\n')
    );
    try {
      await expect(WalkthroughManager.load(filePath)).rejects.toThrow(/enterprise-only-feature/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

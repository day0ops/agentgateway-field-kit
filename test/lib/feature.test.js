import { test, expect, describe } from 'bun:test';
import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { EDITIONS } from '../../src/lib/editions.js';

class DummyBothFeature extends Feature {
  static lastDeployedEdition = null;
  async deploy() {
    DummyBothFeature.lastDeployedEdition = this.edition;
  }
  async cleanup() {}
}

class DummyEnterpriseOnlyFeature extends Feature {
  static SUPPORTED_EDITIONS = ['enterprise'];
  async deploy() {}
  async cleanup() {}
}

FeatureManager.register('__test-dummy-both', DummyBothFeature);
FeatureManager.register('__test-dummy-enterprise-only', DummyEnterpriseOnlyFeature);

describe('Feature.SUPPORTED_EDITIONS default', () => {
  test('base Feature class supports both editions by default', () => {
    expect(Feature.SUPPORTED_EDITIONS).toEqual(EDITIONS);
  });

  test('a subclass with no override inherits the default', () => {
    expect(DummyBothFeature.SUPPORTED_EDITIONS).toEqual(EDITIONS);
  });
});

describe('FeatureManager.getSupportedEditions', () => {
  test('returns the registered feature class SUPPORTED_EDITIONS', () => {
    expect(FeatureManager.getSupportedEditions('__test-dummy-both')).toEqual(EDITIONS);
    expect(FeatureManager.getSupportedEditions('__test-dummy-enterprise-only')).toEqual([
      'enterprise',
    ]);
  });

  test('returns [] for an unregistered feature', () => {
    expect(FeatureManager.getSupportedEditions('__does-not-exist')).toEqual([]);
  });
});

describe('FeatureManager.deploy edition gating (dryRun)', () => {
  test('deploying with no edition option succeeds regardless of SUPPORTED_EDITIONS', async () => {
    await expect(
      FeatureManager.deploy('__test-dummy-enterprise-only', {}, { dryRun: true })
    ).resolves.toEqual([]);
  });

  test('deploying an enterprise-only feature with edition: enterprise succeeds', async () => {
    await expect(
      FeatureManager.deploy(
        '__test-dummy-enterprise-only',
        {},
        { dryRun: true, edition: 'enterprise' }
      )
    ).resolves.toEqual([]);
  });

  test('deploying an enterprise-only feature with edition: opensource throws before instantiation', async () => {
    await expect(
      FeatureManager.deploy(
        '__test-dummy-enterprise-only',
        {},
        { dryRun: true, edition: 'opensource' }
      )
    ).rejects.toThrow(/does not support edition 'opensource'/);
  });

  test('a both-edition feature accepts edition: opensource', async () => {
    await expect(
      FeatureManager.deploy('__test-dummy-both', {}, { dryRun: true, edition: 'opensource' })
    ).resolves.toEqual([]);
  });
});

describe('Feature instance edition resolution', () => {
  test('feature.edition defaults to enterprise when no edition is configured', () => {
    const feature = new DummyBothFeature('__test-dummy-both', {});
    expect(feature.edition).toBe('enterprise');
  });

  test('feature.edition reflects config.edition when set', () => {
    const feature = new DummyBothFeature('__test-dummy-both', { edition: 'opensource' });
    expect(feature.edition).toBe('opensource');
  });

  test('FeatureManager.deploy threads options.edition into the feature instance', async () => {
    await FeatureManager.deploy('__test-dummy-both', {}, { dryRun: true, edition: 'opensource' });
    expect(DummyBothFeature.lastDeployedEdition).toBe('opensource');
  });
});

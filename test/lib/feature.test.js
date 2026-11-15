import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { Feature, FeatureManager, PolicyRegistry } from '../../src/lib/feature.js';
import { EDITIONS } from '../../src/lib/editions.js';
import { KubernetesHelper, Logger } from '../../src/lib/common.js';

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

describe('Feature instance deploymentId resolution', () => {
  test('feature.deploymentId is null when no deploymentId is configured', () => {
    const feature = new DummyBothFeature('__test-dummy-both', {});
    expect(feature.deploymentId).toBeNull();
  });

  test('feature.deploymentId reflects config.deploymentId when set', () => {
    const feature = new DummyBothFeature('__test-dummy-both', { deploymentId: 'my-walkthrough' });
    expect(feature.deploymentId).toBe('my-walkthrough');
  });

  test('FeatureManager.deploy threads options.deploymentId into the feature instance', async () => {
    class CapturingFeature extends Feature {
      async deploy() {
        CapturingFeature.lastDeploymentId = this.deploymentId;
      }
      async cleanup() {}
    }
    FeatureManager.register('__test-capturing-deployment-id', CapturingFeature);
    await FeatureManager.deploy(
      '__test-capturing-deployment-id',
      {},
      { dryRun: true, deploymentId: 'my-walkthrough' }
    );
    expect(CapturingFeature.lastDeploymentId).toBe('my-walkthrough');
  });

  test('FeatureManager.cleanup threads options.deploymentId into the feature instance', async () => {
    class CapturingFeature extends Feature {
      async deploy() {}
      async cleanup() {
        CapturingFeature.lastDeploymentId = this.deploymentId;
      }
    }
    FeatureManager.register('__test-capturing-deployment-id-cleanup', CapturingFeature);
    await FeatureManager.cleanup(
      '__test-capturing-deployment-id-cleanup',
      {},
      { deploymentId: 'my-walkthrough' }
    );
    expect(CapturingFeature.lastDeploymentId).toBe('my-walkthrough');
  });
});

describe('Feature.applyResource deployment labeling', () => {
  let originalApplyYaml, appliedYamlDocs;

  beforeEach(() => {
    appliedYamlDocs = [];
    originalApplyYaml = KubernetesHelper.applyYaml;
    KubernetesHelper.applyYaml = async yamlContent => {
      appliedYamlDocs.push(yamlContent);
    };
  });

  afterEach(() => {
    KubernetesHelper.applyYaml = originalApplyYaml;
  });

  test('stamps agentgateway.dev/deployment on a non-policy resource when deploymentId is set', async () => {
    const feature = new Feature('__test-route-feature', { deploymentId: 'my-walkthrough' });
    await feature.applyResource({
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: { name: 'my-route', labels: { 'agentgateway.dev/feature': 'providers' } },
      spec: {},
    });

    expect(appliedYamlDocs).toHaveLength(1);
    expect(appliedYamlDocs[0]).toContain('agentgateway.dev/deployment: my-walkthrough');
    // Original labels are preserved, not replaced.
    expect(appliedYamlDocs[0]).toContain('agentgateway.dev/feature: providers');
  });

  test('does not stamp anything when deploymentId is not set (unchanged default behavior)', async () => {
    const feature = new Feature('__test-route-feature', {});
    await feature.applyResource({
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: { name: 'my-route' },
      spec: {},
    });

    expect(appliedYamlDocs[0]).not.toContain('agentgateway.dev/deployment');
  });

  test('does not stamp a scalar deployment label on a policy deferred to PolicyRegistry (handled separately by commit())', async () => {
    PolicyRegistry.enable();
    try {
      const feature = new Feature('__test-policy-feature', { deploymentId: 'my-walkthrough' });
      await feature.applyResource({
        apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
        kind: 'EnterpriseAgentgatewayPolicy',
        metadata: { name: 'my-policy' },
        spec: { targetRefs: [{ kind: 'HTTPRoute', name: 'my-route' }], traffic: {} },
      });

      // Deferred to PolicyRegistry - nothing applied directly yet.
      expect(appliedYamlDocs).toHaveLength(0);
      await PolicyRegistry.commit();
      expect(appliedYamlDocs[0]).toContain(
        'agentgateway.dev/contributor-deployments: my-walkthrough'
      );
      expect(appliedYamlDocs[0]).not.toMatch(/^\s*agentgateway\.dev\/deployment:/m);
    } finally {
      PolicyRegistry.disable();
      PolicyRegistry.clear();
    }
  });
});

describe('Feature.deleteByLabel deployment scoping', () => {
  let originalKubectl, calls;

  beforeEach(() => {
    calls = [];
    originalKubectl = KubernetesHelper.kubectl;
    KubernetesHelper.kubectl = async args => {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
  });

  afterEach(() => {
    KubernetesHelper.kubectl = originalKubectl;
  });

  test('adds agentgateway.dev/deployment to the selector when deploymentId is set', async () => {
    const feature = new Feature('__test-route-feature', { deploymentId: 'my-walkthrough' });
    await feature.deleteByLabel('HTTPRoute', { 'agentgateway.dev/feature': 'providers' });

    const selector = calls[0][calls[0].indexOf('-l') + 1];
    expect(selector).toContain('agentgateway.dev/feature=providers');
    expect(selector).toContain('agentgateway.dev/deployment=my-walkthrough');
  });

  test('leaves the selector unscoped when deploymentId is not set (unchanged default behavior, e.g. addons)', async () => {
    const feature = new Feature('__test-route-feature', {});
    await feature.deleteByLabel('HTTPRoute', { 'agentgateway.dev/feature': 'providers' });

    const selector = calls[0][calls[0].indexOf('-l') + 1];
    expect(selector).toBe('agentgateway.dev/feature=providers');
  });
});

describe('PolicyRegistry deployment-contributor tracking', () => {
  beforeEach(() => {
    PolicyRegistry.enable();
  });

  afterEach(() => {
    PolicyRegistry.disable();
    PolicyRegistry.clear();
  });

  function policy(targetName = 'my-route') {
    return {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: { name: 'placeholder' },
      spec: { targetRefs: [{ kind: 'HTTPRoute', name: targetName }], traffic: {} },
    };
  }

  test('a single contributing deployment is recorded as agentgateway.dev/contributor-deployments', async () => {
    PolicyRegistry.register(policy(), 'feature-a', 'default', 'walkthrough-a');
    const [doc] = await PolicyRegistry.commit({ dryRun: true });
    expect(doc).toContain('agentgateway.dev/contributor-deployments: walkthrough-a');
  });

  test('two different deployments contributing to the same target are both recorded, in registration order', async () => {
    PolicyRegistry.register(policy(), 'feature-a', 'default', 'walkthrough-a');
    PolicyRegistry.register(policy(), 'feature-b', 'default', 'walkthrough-b');
    const [doc] = await PolicyRegistry.commit({ dryRun: true });
    expect(doc).toContain('agentgateway.dev/contributor-deployments: walkthrough-a_walkthrough-b');
  });

  test('the label is omitted entirely when no caller ever passed a deploymentId', async () => {
    PolicyRegistry.register(policy(), 'feature-a', 'default');
    const [doc] = await PolicyRegistry.commit({ dryRun: true });
    expect(doc).not.toContain('agentgateway.dev/contributor-deployments');
  });
});

describe('PolicyRegistry.cleanupMergedPolicies', () => {
  let originalKubectl, originalWarn, warnings;

  beforeEach(() => {
    warnings = [];
    originalWarn = Logger.warn;
    Logger.warn = msg => warnings.push(msg);
  });

  afterEach(() => {
    KubernetesHelper.kubectl = originalKubectl;
    Logger.warn = originalWarn;
  });

  function mockList(items) {
    originalKubectl = KubernetesHelper.kubectl;
    KubernetesHelper.kubectl = async args => {
      if (args[0] === 'get') {
        return { exitCode: 0, stdout: JSON.stringify({ items }), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
  }

  test('deletes a merged policy whose sole contributing deployment matches', async () => {
    mockList([
      {
        metadata: {
          name: 'merged-a-b-my-route',
          labels: { 'agentgateway.dev/contributor-deployments': 'my-walkthrough' },
        },
      },
    ]);
    const deleteCalls = [];
    const realKubectl = KubernetesHelper.kubectl;
    KubernetesHelper.kubectl = async args => {
      if (args[0] === 'delete') deleteCalls.push(args);
      return realKubectl(args);
    };

    await PolicyRegistry.cleanupMergedPolicies('my-walkthrough', 'agentgateway-system');

    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toContain('merged-a-b-my-route');
  });

  test('skips and warns when the merged policy is still shared with another deployment', async () => {
    mockList([
      {
        metadata: {
          name: 'merged-a-b-my-route',
          labels: {
            'agentgateway.dev/contributor-deployments': 'my-walkthrough_someone-elses-usecase',
          },
        },
      },
    ]);
    const deleteCalls = [];
    const realKubectl = KubernetesHelper.kubectl;
    KubernetesHelper.kubectl = async args => {
      if (args[0] === 'delete') deleteCalls.push(args);
      return realKubectl(args);
    };

    await PolicyRegistry.cleanupMergedPolicies('my-walkthrough', 'agentgateway-system');

    expect(deleteCalls).toHaveLength(0);
    expect(warnings.some(w => w.includes('someone-elses-usecase'))).toBe(true);
  });

  test('silently skips a merged policy belonging entirely to another deployment', async () => {
    mockList([
      {
        metadata: {
          name: 'merged-x-y-someone-elses-route',
          labels: { 'agentgateway.dev/contributor-deployments': 'someone-elses-usecase' },
        },
      },
    ]);
    const deleteCalls = [];
    const realKubectl = KubernetesHelper.kubectl;
    KubernetesHelper.kubectl = async args => {
      if (args[0] === 'delete') deleteCalls.push(args);
      return realKubectl(args);
    };

    await PolicyRegistry.cleanupMergedPolicies('my-walkthrough', 'agentgateway-system');

    expect(deleteCalls).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test('is a no-op when there are no merged policies', async () => {
    mockList([]);
    await expect(
      PolicyRegistry.cleanupMergedPolicies('my-walkthrough', 'agentgateway-system')
    ).resolves.toBeUndefined();
  });

  test('warns but does not throw when the list call fails entirely', async () => {
    originalKubectl = KubernetesHelper.kubectl;
    KubernetesHelper.kubectl = async () => {
      throw new Error('cluster unreachable');
    };

    await expect(
      PolicyRegistry.cleanupMergedPolicies('my-walkthrough', 'agentgateway-system')
    ).resolves.toBeUndefined();
  });
});

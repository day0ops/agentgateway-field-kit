import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { Feature, FeatureManager, PolicyRegistry } from '../../src/lib/feature.js';
import { EDITIONS } from '../../src/lib/editions.js';
import { KubernetesHelper, Logger } from '../../src/lib/common.js';
import yaml from 'js-yaml';

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

  test('a deploymentId over 63 bytes is truncated (an unsanitized one would fail every kubectl apply)', () => {
    const feature = new DummyBothFeature('__test-dummy-both', {
      deploymentId: 'a'.repeat(100),
    });
    expect(feature.deploymentId).toHaveLength(63);
  });

  test("a deploymentId containing '_' has it replaced with '-' (it would otherwise corrupt the '_'-joined multi-deployment label)", () => {
    const feature = new DummyBothFeature('__test-dummy-both', {
      deploymentId: 'my_usecase_name',
    });
    expect(feature.deploymentId).toBe('my-usecase-name');
  });

  test('a deploymentId with characters invalid in a label value has them replaced with -', () => {
    const feature = new DummyBothFeature('__test-dummy-both', {
      deploymentId: 'security/openfga-rebac',
    });
    expect(feature.deploymentId).toBe('security-openfga-rebac');
  });

  test('a deploymentId trims leading/trailing non-alphanumeric characters left over after sanitizing', () => {
    const feature = new DummyBothFeature('__test-dummy-both', {
      deploymentId: '-leading-trailing-',
    });
    expect(feature.deploymentId).toBe('leading-trailing');
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
  let originalApplyYaml, originalKubectl, appliedYamlDocs;

  beforeEach(() => {
    appliedYamlDocs = [];
    originalApplyYaml = KubernetesHelper.applyYaml;
    KubernetesHelper.applyYaml = async yamlContent => {
      appliedYamlDocs.push(yamlContent);
    };
    // commit() (used below, without dryRun) reads back the live object's existing
    // contributor-deployments annotation before writing - mock it so this suite never
    // depends on a real cluster. Default: no existing object (as if nothing's been deployed
    // yet).
    originalKubectl = KubernetesHelper.kubectl;
    KubernetesHelper.kubectl = async () => ({ exitCode: 1, stdout: '', stderr: 'not found' });
  });

  afterEach(() => {
    KubernetesHelper.applyYaml = originalApplyYaml;
    KubernetesHelper.kubectl = originalKubectl;
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

  test('DOES stamp the scalar deployment label on a policy-shaped resource when PolicyRegistry is disabled (never deferred, so never merged)', async () => {
    expect(PolicyRegistry.isEnabled()).toBe(false);
    const feature = new Feature('__test-policy-feature', { deploymentId: 'my-walkthrough' });
    await feature.applyResource({
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: { name: 'my-policy' },
      spec: { targetRefs: [{ kind: 'HTTPRoute', name: 'my-route' }], traffic: {} },
    });

    expect(appliedYamlDocs).toHaveLength(1);
    expect(appliedYamlDocs[0]).toContain('agentgateway.dev/deployment: my-walkthrough');
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

  describe('cross-session union with the live object (non-dry-run commit only)', () => {
    let originalKubectl, originalApplyYaml, appliedYamlDocs;

    beforeEach(() => {
      appliedYamlDocs = [];
      originalApplyYaml = KubernetesHelper.applyYaml;
      KubernetesHelper.applyYaml = async yamlContent => {
        appliedYamlDocs.push(yamlContent);
      };
      originalKubectl = KubernetesHelper.kubectl;
    });

    afterEach(() => {
      KubernetesHelper.kubectl = originalKubectl;
      KubernetesHelper.applyYaml = originalApplyYaml;
    });

    function policyWithNamespace(targetName = 'my-route') {
      return {
        apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
        kind: 'EnterpriseAgentgatewayPolicy',
        metadata: { name: 'placeholder', namespace: 'agentgateway-system' },
        spec: { targetRefs: [{ kind: 'HTTPRoute', name: targetName }], traffic: {} },
      };
    }

    test("a second, separate deploy's commit() unions its own contributor with whatever the live object already lists, instead of overwriting it", async () => {
      // Simulates two independent processes (two separate `agw walkthrough run` invocations):
      // this process's PolicyRegistry only ever registered 'walkthrough-b', but the object
      // already live on the cluster (from an earlier, separate commit() by 'walkthrough-a')
      // lists 'walkthrough-a'.
      KubernetesHelper.kubectl = async () => ({
        exitCode: 0,
        stdout: 'walkthrough-a',
        stderr: '',
      });

      PolicyRegistry.register(policyWithNamespace(), 'feature-a', 'default', 'walkthrough-b');
      await PolicyRegistry.commit();

      expect(appliedYamlDocs[0]).toContain(
        'agentgateway.dev/contributor-deployments: walkthrough-a_walkthrough-b'
      );
    });

    test('a first-ever deploy with no live object yet records only its own contributor', async () => {
      KubernetesHelper.kubectl = async () => ({ exitCode: 1, stdout: '', stderr: 'not found' });

      PolicyRegistry.register(policyWithNamespace(), 'feature-a', 'default', 'walkthrough-a');
      await PolicyRegistry.commit();

      expect(appliedYamlDocs[0]).toContain(
        'agentgateway.dev/contributor-deployments: walkthrough-a'
      );
    });

    test('contributor-deployments is written as an annotation, not a label - a label value is capped at 63 bytes, and a joined multi-deployment list (prefixed usecase./walkthrough. names) can exceed that', async () => {
      // A realistically long existing contributor, close to what a single sanitized,
      // prefixed name can already be (63 bytes) - unioned with this commit's own contributor,
      // the combined value alone is well past what a label value could legally hold.
      const longExisting = `usecase.${'a'.repeat(55)}`;
      KubernetesHelper.kubectl = async () => ({ exitCode: 0, stdout: longExisting, stderr: '' });

      PolicyRegistry.register(
        policyWithNamespace(),
        'feature-a',
        'default',
        'walkthrough.budget-and-spend-limits'
      );
      await PolicyRegistry.commit();

      const combinedValue = `${longExisting}_walkthrough.budget-and-spend-limits`;
      expect(combinedValue.length).toBeGreaterThan(63);

      const parsed = yaml.load(appliedYamlDocs[0]);
      // Must appear whole, under annotations (no length limit) - not under labels, which
      // Kubernetes would reject outright for a value this long.
      expect(parsed.metadata.annotations?.['agentgateway.dev/contributor-deployments']).toBe(
        combinedValue
      );
      expect(parsed.metadata.labels?.['agentgateway.dev/contributor-deployments']).toBeUndefined();
    });
  });
});

describe('PolicyRegistry.cleanupMergedPolicies', () => {
  let originalKubectl, originalWarn, originalInfo, warnings, infos, calls, items;

  beforeEach(() => {
    warnings = [];
    originalWarn = Logger.warn;
    Logger.warn = msg => warnings.push(msg);
    infos = [];
    originalInfo = Logger.info;
    Logger.info = msg => infos.push(msg);

    calls = [];
    items = [];
    originalKubectl = KubernetesHelper.kubectl;
    KubernetesHelper.kubectl = async args => {
      calls.push(args);
      if (args[0] === 'get') {
        return { exitCode: 0, stdout: JSON.stringify({ items }), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
  });

  afterEach(() => {
    KubernetesHelper.kubectl = originalKubectl;
    Logger.warn = originalWarn;
    Logger.info = originalInfo;
  });

  function callsOf(verb) {
    return calls.filter(args => args[0] === verb);
  }

  test('sanitizes its own deploymentId argument before comparing, so an unsanitized caller id still matches the sanitized value features actually stamp', async () => {
    // Features stamp this.deploymentId - already sanitized by the Feature constructor - so a
    // caller passing the raw, unsanitized usecase/walkthrough name here must still match.
    items = [
      {
        metadata: {
          name: 'merged-a-b-my-route',
          annotations: { 'agentgateway.dev/contributor-deployments': 'my-usecase' },
        },
      },
    ];

    await PolicyRegistry.cleanupMergedPolicies('my_usecase', 'agentgateway-system');

    expect(callsOf('delete')).toHaveLength(1);
  });

  test('deletes a merged policy whose sole contributing deployment matches', async () => {
    items = [
      {
        metadata: {
          name: 'merged-a-b-my-route',
          annotations: { 'agentgateway.dev/contributor-deployments': 'my-walkthrough' },
        },
      },
    ];

    await PolicyRegistry.cleanupMergedPolicies('my-walkthrough', 'agentgateway-system');

    const deleteCalls = callsOf('delete');
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toContain('merged-a-b-my-route');
  });

  test('skips deletion, warns, and trims itself out of the contributor-deployments annotation when the merged policy is still shared with another deployment', async () => {
    items = [
      {
        metadata: {
          name: 'merged-a-b-my-route',
          annotations: {
            'agentgateway.dev/contributor-deployments': 'my-walkthrough_someone-elses-usecase',
          },
        },
      },
    ];

    await PolicyRegistry.cleanupMergedPolicies('my-walkthrough', 'agentgateway-system');

    expect(callsOf('delete')).toHaveLength(0);
    expect(warnings.some(w => w.includes('someone-elses-usecase'))).toBe(true);
    // The object itself is left alone (spec untouched) - only its contributor-deployments
    // annotation shrinks, so whoever cleans up last still sees itself as the sole contributor.
    const annotateCalls = callsOf('annotate');
    expect(annotateCalls).toHaveLength(1);
    expect(annotateCalls[0]).toContain('merged-a-b-my-route');
    expect(annotateCalls[0]).toContain(
      'agentgateway.dev/contributor-deployments=someone-elses-usecase'
    );
    expect(annotateCalls[0]).toContain('--overwrite');
  });

  test('silently skips a merged policy belonging entirely to another deployment', async () => {
    items = [
      {
        metadata: {
          name: 'merged-x-y-someone-elses-route',
          annotations: { 'agentgateway.dev/contributor-deployments': 'someone-elses-usecase' },
        },
      },
    ];

    await PolicyRegistry.cleanupMergedPolicies('my-walkthrough', 'agentgateway-system');

    expect(callsOf('delete')).toHaveLength(0);
    expect(callsOf('annotate')).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test('skips (no warning) an unlabeled merged policy predating this fix, rather than assuming it is safe to delete, but surfaces an info note so the gap is not silent', async () => {
    items = [{ metadata: { name: 'merged-a-b-my-route' } }];

    await PolicyRegistry.cleanupMergedPolicies('my-walkthrough', 'agentgateway-system');

    expect(callsOf('delete')).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(infos.some(i => i.includes('1 merged EnterpriseAgentgatewayPolicy'))).toBe(true);
  });

  test('deletes nothing when deploymentId itself is falsy - no caller has proved ownership of anything', async () => {
    items = [
      {
        metadata: {
          name: 'merged-a-b-my-route',
          annotations: { 'agentgateway.dev/contributor-deployments': 'some-deployment' },
        },
      },
    ];

    await PolicyRegistry.cleanupMergedPolicies(undefined, 'agentgateway-system');

    expect(callsOf('delete')).toHaveLength(0);
  });

  test('is a no-op when there are no merged policies', async () => {
    await expect(
      PolicyRegistry.cleanupMergedPolicies('my-walkthrough', 'agentgateway-system')
    ).resolves.toBeUndefined();
    expect(callsOf('delete')).toHaveLength(0);
  });

  test('warns but does not throw when the list call fails entirely', async () => {
    KubernetesHelper.kubectl = async () => {
      throw new Error('cluster unreachable');
    };

    await expect(
      PolicyRegistry.cleanupMergedPolicies('my-walkthrough', 'agentgateway-system')
    ).resolves.toBeUndefined();
    expect(warnings.some(w => w.includes('cluster unreachable'))).toBe(true);
  });
});

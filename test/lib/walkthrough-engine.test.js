import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import yaml from 'js-yaml';
import { Feature, FeatureManager, PolicyRegistry } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';
import { EDITION_GATEWAY_NAME } from '../../src/lib/editions.js';
import { WalkthroughEngine } from '../../src/lib/walkthrough-engine.js';

// Mirrors every real Feature subclass in this repo, which never performs a raw side effect
// directly - only through applyResource()/deleteResource(), which already check this.dryRun.
// ensureAppliedThrough() makes a best-effort dry-run preview deploy call before every real
// deploy call (to capture "Applied Configuration" YAML), so without this guard the preview
// call would double-record here.
class RecordingFeature extends Feature {
  async deploy() {
    if (this.dryRun) return;
    RecordingFeature.deployed.push({ name: this.name, config: this.config });
  }
  async cleanup() {
    RecordingFeature.cleanedUp.push({ name: this.name, config: this.config });
  }
}
RecordingFeature.deployed = [];
RecordingFeature.cleanedUp = [];

class PolicyFeature extends Feature {
  async deploy() {
    await this.applyResource({
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: { name: 'policy-under-test', namespace: this.namespace },
      spec: {
        targetRefs: [{ kind: 'HTTPRoute', name: 'routing-basic' }],
        traffic: { jwtAuth: {} },
      },
    });
  }
  async cleanup() {}
}

function buildWalkthrough(overrides = {}) {
  return {
    screens: [
      {
        name: 'one',
        setup: [{ name: 'recording-feature', config: { step: 'one' } }],
        steps: [
          { kind: 'http', method: 'GET', url: 'http://example.com/a', expectStatus: 200 },
          { kind: 'http', method: 'GET', url: 'http://example.com/b', expectStatus: 200 },
        ],
      },
      {
        name: 'two',
        teardown: [{ name: 'recording-feature', config: { step: 'one-teardown' } }],
        setup: [{ name: 'recording-feature', config: { step: 'two' } }],
        steps: [{ kind: 'http', method: 'GET', url: 'http://example.com/c', expectStatus: 200 }],
      },
    ],
    credentials: {},
    preProvision: [],
    edition: 'enterprise',
    ...overrides,
  };
}

let originalFeatures, originalGatewayRef, originalDefaultNamespace, originalFetch;
let originalEnsureNamespace, originalApplyYaml;
let appliedYamlDocs;

beforeEach(() => {
  RecordingFeature.deployed = [];
  RecordingFeature.cleanedUp = [];
  originalFeatures = FeatureManager.features;
  FeatureManager.features = new Map();
  FeatureManager.register('recording-feature', RecordingFeature);
  FeatureManager.register('policy-feature', PolicyFeature);
  originalGatewayRef = FeatureManager.gatewayRef;
  originalDefaultNamespace = FeatureManager.defaultNamespace;
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('ok', { status: 200 });

  // FeatureManager.deploy()/cleanup() unconditionally call KubernetesHelper.ensureNamespace
  // before a feature's own deploy()/cleanup() runs, and PolicyRegistry.commit() calls
  // KubernetesHelper.applyYaml - neither must reach a real cluster in these tests.
  originalEnsureNamespace = KubernetesHelper.ensureNamespace;
  originalApplyYaml = KubernetesHelper.applyYaml;
  KubernetesHelper.ensureNamespace = async () => {};
  appliedYamlDocs = [];
  KubernetesHelper.applyYaml = async yamlContent => {
    appliedYamlDocs.push(yamlContent);
  };
});

afterEach(() => {
  FeatureManager.features = originalFeatures;
  FeatureManager.gatewayRef = originalGatewayRef;
  FeatureManager.defaultNamespace = originalDefaultNamespace;
  globalThis.fetch = originalFetch;
  KubernetesHelper.ensureNamespace = originalEnsureNamespace;
  KubernetesHelper.applyYaml = originalApplyYaml;
  PolicyRegistry.clear();
  PolicyRegistry.disable();
});

describe('WalkthroughEngine construction', () => {
  test("sets the gateway ref to the resolved edition's gateway on construction", () => {
    new WalkthroughEngine(buildWalkthrough({ edition: 'opensource' }));
    expect(FeatureManager.getGatewayRef()).toEqual({
      name: EDITION_GATEWAY_NAME.opensource,
      namespace: FeatureManager.getDefaultNamespace(),
    });
  });

  test('applies spec.namespace as the default namespace before setting the gateway ref', () => {
    new WalkthroughEngine(buildWalkthrough({ namespace: 'walkthrough-ns' }));
    expect(FeatureManager.getDefaultNamespace()).toBe('walkthrough-ns');
    expect(FeatureManager.getGatewayRef().namespace).toBe('walkthrough-ns');
  });

  test('starts at screen 0, step 0, with no setup applied yet', () => {
    const engine = new WalkthroughEngine(buildWalkthrough());
    expect(engine.screenIndex).toBe(0);
    expect(engine.stepIndex).toBe(0);
    expect(RecordingFeature.deployed).toEqual([]);
  });
});

describe('WalkthroughEngine navigation', () => {
  test('handleRight on an unfired step runs it; handleRight again advances', async () => {
    const engine = new WalkthroughEngine(buildWalkthrough());
    await engine.handleRight(); // applies screen 0 setup
    // toMatchObject, not toEqual: FeatureManager.deploy() always injects namespace/edition
    // into the feature's config alongside what the walkthrough screen declared.
    expect(RecordingFeature.deployed).toMatchObject([
      { name: 'recording-feature', config: { step: 'one' } },
    ]);

    await engine.handleRight(); // previews step 0 (http)
    expect(engine.getStepResult()).toMatchObject({
      kind: 'http',
      request: { url: 'http://example.com/a' },
    });

    await engine.handleRight(); // fires step 0
    expect(engine.getStepResult()).toMatchObject({ status: 200 });
    expect(engine.stepIndex).toBe(0);

    await engine.handleRight(); // advances to step 1
    expect(engine.stepIndex).toBe(1);
    expect(engine.getStepResult()).toBeNull();
  });

  test("crossing a screen boundary runs the next screen's teardown then setup exactly once", async () => {
    const engine = new WalkthroughEngine(buildWalkthrough());
    await engine.handleRight(); // screen 0 setup
    await engine.handleRight(); // step 0 preview
    await engine.handleRight(); // step 0 fire
    await engine.handleRight(); // advance to step 1
    await engine.handleRight(); // step 1 preview
    await engine.handleRight(); // step 1 fire
    await engine.handleRight(); // crosses into screen 1 (indices only - lazy apply)
    await engine.handleRight(); // applies screen 1's teardown+setup

    // toMatchObject, not toEqual: FeatureManager.deploy()/cleanup() always inject
    // namespace/edition into the feature's config alongside what the screen declared.
    expect(RecordingFeature.cleanedUp).toMatchObject([
      { name: 'recording-feature', config: { step: 'one-teardown' } },
    ]);
    expect(RecordingFeature.deployed).toMatchObject([
      { name: 'recording-feature', config: { step: 'one' } },
      { name: 'recording-feature', config: { step: 'two' } },
    ]);
    expect(engine.screenIndex).toBe(1);
  });

  test('jumpToScreen ahead catches up every intervening screen in order, once', async () => {
    const engine = new WalkthroughEngine(buildWalkthrough());
    await engine.jumpToScreen(1);
    expect(RecordingFeature.cleanedUp).toMatchObject([
      { name: 'recording-feature', config: { step: 'one-teardown' } },
    ]);
    expect(RecordingFeature.deployed).toMatchObject([
      { name: 'recording-feature', config: { step: 'one' } },
      { name: 'recording-feature', config: { step: 'two' } },
    ]);
    expect(engine.screenIndex).toBe(1);
  });

  test("jumpToScreen emits 'running' before 'change', same as handleRight's apply-batch branch", async () => {
    const engine = new WalkthroughEngine(buildWalkthrough());
    const events = [];
    engine.on('running', () => events.push('running'));
    engine.on('change', () => events.push('change'));

    await engine.jumpToScreen(1);

    expect(events).toEqual(['running', 'change']);
  });

  test('re-entering an already-applied screen re-runs its teardown/setup and clears cached step results', async () => {
    const engine = new WalkthroughEngine(buildWalkthrough());
    await engine.jumpToScreen(1);
    RecordingFeature.deployed = [];
    RecordingFeature.cleanedUp = [];

    await engine.jumpToScreen(1);
    expect(RecordingFeature.cleanedUp).toMatchObject([
      { name: 'recording-feature', config: { step: 'one-teardown' } },
    ]);
    expect(RecordingFeature.deployed).toMatchObject([
      { name: 'recording-feature', config: { step: 'two' } },
    ]);
    expect(engine.getStepResult()).toBeNull();
  });
});

describe('WalkthroughEngine deploy calls', () => {
  test('passes the resolved edition to every FeatureManager.deploy/cleanup call', async () => {
    const seen = [];
    const originalDeploy = FeatureManager.deploy;
    const originalCleanup = FeatureManager.cleanup;
    FeatureManager.deploy = async (name, config, options) => {
      seen.push({ fn: 'deploy', options });
      return originalDeploy.call(FeatureManager, name, config, options);
    };
    FeatureManager.cleanup = async (name, config, options) => {
      seen.push({ fn: 'cleanup', options });
      return originalCleanup.call(FeatureManager, name, config, options);
    };
    try {
      const engine = new WalkthroughEngine(buildWalkthrough({ edition: 'opensource' }));
      await engine.jumpToScreen(1);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every(call => call.options.edition === 'opensource')).toBe(true);
      expect(seen.some(call => call.fn === 'cleanup')).toBe(true);
    } finally {
      FeatureManager.deploy = originalDeploy;
      FeatureManager.cleanup = originalCleanup;
    }
  });
});

describe('WalkthroughEngine PolicyRegistry integration', () => {
  test("coalesces a screen-entry batch's policy resources into one committed object, then disables", async () => {
    const walkthrough = {
      screens: [{ name: 'one', setup: [{ name: 'policy-feature' }], steps: [] }],
      credentials: {},
      preProvision: [],
      edition: 'enterprise',
    };
    const engine = new WalkthroughEngine(walkthrough);
    await engine.ensureAppliedThrough(0);

    expect(PolicyRegistry.isEnabled()).toBe(false);
    expect(appliedYamlDocs.some(doc => doc.includes('EnterpriseAgentgatewayPolicy'))).toBe(true);
  });

  test("a setup feature's best-effort dry-run preview call doesn't double-register it as its own policy contributor", async () => {
    // Regression test: the dry-run capture call in ensureAppliedThrough runs while
    // PolicyRegistry is enabled for the whole batch, same as the real deploy call right
    // after it. Without reverting PolicyRegistry's state between the two, a single
    // policy-emitting feature gets registered twice and is merged with itself, producing
    // a "merged-<name>-<name>-..." resource name instead of the clean single-contributor
    // "<name>-..." name.
    const walkthrough = {
      screens: [{ name: 'one', setup: [{ name: 'policy-feature' }], steps: [] }],
      credentials: {},
      preProvision: [],
      edition: 'enterprise',
    };
    const engine = new WalkthroughEngine(walkthrough);
    await engine.ensureAppliedThrough(0);

    const policyDoc = appliedYamlDocs
      .map(doc => yaml.load(doc))
      .find(doc => doc.kind === 'EnterpriseAgentgatewayPolicy');
    expect(policyDoc.metadata.name).toBe('policy-feature-routing-basic');
    expect(policyDoc.metadata.labels['agentgateway.dev/contributors']).toBe('policy-feature');
  });

  test('a policy-emitting feature has no "Applied Configuration" preview captured (deferred to PolicyRegistry, not _dryRunYaml)', async () => {
    const walkthrough = {
      screens: [{ name: 'one', setup: [{ name: 'policy-feature' }], steps: [] }],
      credentials: {},
      preProvision: [],
      edition: 'enterprise',
    };
    const engine = new WalkthroughEngine(walkthrough);
    await engine.ensureAppliedThrough(0);
    expect(engine.getAppliedYaml(0)).toBeNull();
  });
});

describe('WalkthroughEngine prompt steps', () => {
  function buildPromptWalkthrough() {
    return {
      screens: [
        {
          name: 'one',
          setup: [],
          steps: [{ kind: 'prompt', label: 'API key', variableName: 'apiKey' }],
        },
      ],
      credentials: {},
      preProvision: [],
      edition: 'enterprise',
    };
  }

  test('handleRight on a prompt step with no result is a no-op (submitPromptValue drives it)', async () => {
    const engine = new WalkthroughEngine(buildPromptWalkthrough());
    await engine.handleRight(); // applies screen 0 setup (empty)
    await engine.handleRight(); // prompt step: no-op, nothing to fire
    expect(engine.getStepResult()).toBeNull();
  });

  test('submitPromptValue stores the value as a variable and reveals a result', () => {
    const engine = new WalkthroughEngine(buildPromptWalkthrough());
    engine.submitPromptValue('secret-123');
    expect(engine.variables.get('apiKey')).toBe('secret-123');
    expect(engine.getStepResult()).toEqual({
      kind: 'prompt',
      variableName: 'apiKey',
      value: 'secret-123',
    });
    expect(engine.isResponseRevealed()).toBe(true);
  });
});

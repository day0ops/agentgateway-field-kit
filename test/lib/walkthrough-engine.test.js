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

// A second, distinct policy-emitting feature targeting the same ref as PolicyFeature, with a
// different (non-conflicting) traffic field - for proving real cross-feature coalescing, not
// just "one feature registers fine".
class PolicyFeatureB extends Feature {
  async deploy() {
    await this.applyResource({
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: { name: 'policy-b-under-test', namespace: this.namespace },
      spec: {
        targetRefs: [{ kind: 'HTTPRoute', name: 'routing-basic' }],
        traffic: { rateLimit: {} },
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
  FeatureManager.register('policy-feature-b', PolicyFeatureB);
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
    // Advance organically (not via jumpToScreen) into screen 1 and fire its one step, so there's
    // a real cached result and revealed response to prove gets cleared below - a screen that was
    // never fired would pass the getStepResult()/isResponseRevealed() assertions trivially.
    await engine.handleRight(); // applies screen 0 setup
    await engine.handleRight(); // preview screen 0 step 0
    await engine.handleRight(); // fire screen 0 step 0
    await engine.handleRight(); // advance to screen 0 step 1
    await engine.handleRight(); // preview screen 0 step 1
    await engine.handleRight(); // fire screen 0 step 1
    await engine.handleRight(); // cross into screen 1 (lazy - indices only)
    await engine.handleRight(); // apply screen 1's teardown+setup
    await engine.handleRight(); // preview screen 1 step 0
    await engine.handleRight(); // fire screen 1 step 0
    expect(engine.getStepResult()).toMatchObject({ status: 200 });
    expect(engine.isResponseRevealed()).toBe(true);

    await engine.jumpToScreen(0); // jump away
    RecordingFeature.deployed = [];
    RecordingFeature.cleanedUp = [];

    await engine.jumpToScreen(1); // re-enter
    expect(RecordingFeature.cleanedUp).toMatchObject([
      { name: 'recording-feature', config: { step: 'one-teardown' } },
    ]);
    expect(RecordingFeature.deployed).toMatchObject([
      { name: 'recording-feature', config: { step: 'two' } },
    ]);
    expect(engine.getStepResult()).toBeNull();
    expect(engine.isResponseRevealed()).toBe(false);
  });
});

describe('WalkthroughEngine zero-step screens', () => {
  test('a screen with no steps applies its setup then advances straight to the next screen on right-arrow', async () => {
    const walkthrough = {
      screens: [
        {
          name: 'intro',
          setup: [{ name: 'recording-feature', config: { step: 'intro' } }],
          // steps omitted entirely - a narration-only intro screen
        },
        {
          name: 'two',
          setup: [{ name: 'recording-feature', config: { step: 'two' } }],
          steps: [{ kind: 'http', method: 'GET', url: 'http://example.com/c', expectStatus: 200 }],
        },
      ],
      credentials: {},
      preProvision: [],
      edition: 'enterprise',
    };
    const engine = new WalkthroughEngine(walkthrough);

    await engine.handleRight(); // applies screen 0 (intro) setup
    expect(RecordingFeature.deployed).toMatchObject([
      { name: 'recording-feature', config: { step: 'intro' } },
    ]);
    expect(engine.screenIndex).toBe(0);

    await engine.handleRight(); // no steps to run - advances straight to screen 1
    expect(engine.screenIndex).toBe(1);
    expect(engine.stepIndex).toBe(0);
  });

  test('right-arrow on the last screen with no steps does nothing, after its setup is applied', async () => {
    const walkthrough = {
      screens: [
        {
          name: 'only',
          setup: [{ name: 'recording-feature', config: { step: 'only' } }],
          steps: [],
        },
      ],
      credentials: {},
      preProvision: [],
      edition: 'enterprise',
    };
    const engine = new WalkthroughEngine(walkthrough);

    await engine.handleRight(); // applies setup
    await engine.handleRight(); // no steps, last screen - no-op

    expect(engine.screenIndex).toBe(0);
    expect(engine.stepIndex).toBe(0);
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
  test("coalesces a screen-entry batch's two distinct features' policy resources into one merged, committed object, then disables", async () => {
    const walkthrough = {
      screens: [
        {
          name: 'one',
          setup: [{ name: 'policy-feature' }, { name: 'policy-feature-b' }],
          steps: [],
        },
      ],
      credentials: {},
      preProvision: [],
      edition: 'enterprise',
    };
    const engine = new WalkthroughEngine(walkthrough);
    await engine.ensureAppliedThrough(0);

    expect(PolicyRegistry.isEnabled()).toBe(false);
    const committedDoc = appliedYamlDocs
      .map(doc => yaml.load(doc))
      .find(doc => doc.kind === 'EnterpriseAgentgatewayPolicy');
    expect(committedDoc.metadata.name).toBe('merged-policy-feature-policy-feature-b-routing-basic');
    expect(committedDoc.metadata.labels['agentgateway.dev/contributors']).toBe(
      'policy-feature_policy-feature-b'
    );
    // Both features' fields actually merged into the one committed resource.
    expect(committedDoc.spec.traffic.jwtAuth).toBeDefined();
    expect(committedDoc.spec.traffic.rateLimit).toBeDefined();
  });

  test('a policy-emitting feature gets a real "Applied Configuration" preview of its own unmerged resource, and the real deploy still commits a clean single-contributor name', async () => {
    // Disabling PolicyRegistry for just the dry-run capture call (not snapshotting/restoring its
    // maps) makes Feature.applyResource fall through to its normal _dryRunYaml path for that one
    // call, so the preview shows this feature's own real YAML - and, since that call never
    // touches PolicyRegistry's maps at all, the real deploy call right after it is the only call
    // that ever registers this feature as a contributor.
    const walkthrough = {
      screens: [{ name: 'one', setup: [{ name: 'policy-feature' }], steps: [] }],
      credentials: {},
      preProvision: [],
      edition: 'enterprise',
    };
    const engine = new WalkthroughEngine(walkthrough);
    await engine.ensureAppliedThrough(0);

    const previewYaml = engine.getAppliedYaml(0);
    expect(previewYaml).toContain('EnterpriseAgentgatewayPolicy');
    const previewDoc = yaml.load(previewYaml);
    expect(previewDoc.metadata.name).toBe('policy-under-test'); // the feature's own, un-renamed resource
    expect(previewDoc.metadata.name).not.toContain('merged-');

    const committedDoc = appliedYamlDocs
      .map(doc => yaml.load(doc))
      .find(doc => doc.kind === 'EnterpriseAgentgatewayPolicy');
    expect(committedDoc.metadata.name).toBe('policy-feature-routing-basic');
    expect(committedDoc.metadata.labels['agentgateway.dev/contributors']).toBe('policy-feature');
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

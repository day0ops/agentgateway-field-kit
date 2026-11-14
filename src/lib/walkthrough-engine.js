import { EventEmitter } from 'node:events';
import { FeatureManager, PolicyRegistry } from './feature.js';
import { EDITION_GATEWAY_NAME } from './editions.js';
import { runStep, buildHttpRequest, executeHttpRequest } from './walkthrough-steps.js';
import { CredentialManager } from './oidc-credential.js';

// FeatureManager.deploy's own spinner renders directly to the terminal via ora - fine before
// the TUI mounts (preProvision), but every screen past the first applies its setup from
// inside an already-mounted ink app, where a second renderer fighting for the same terminal
// would corrupt the display. Passing this silences it: confirmed against src/lib/feature.js
// that FeatureManager only ever calls setText()/checks isSpinning on a supplied spinner, never
// start()/succeed()/fail(), once that spinner is externally supplied.
const SILENT_SPINNER = { setText() {}, isSpinning: false };

/**
 * Drives navigation and setup application for a resolved walkthrough. UI-agnostic -
 * the ink TUI is a thin rendering layer that subscribes to 'change'/'running' events
 * and calls handleRight/handleLeft/jumpToScreen/submitPromptValue in response to input.
 */
export class WalkthroughEngine extends EventEmitter {
  /** @param {{screens: object[], credentials: object, preProvision: object[], edition: string, namespace?: string}} walkthrough */
  constructor(walkthrough) {
    super();
    this.walkthrough = walkthrough;
    this.edition = walkthrough.edition;
    this.screenIndex = 0;
    this.stepIndex = 0;
    this.appliedScreens = new Set();
    this.appliedYaml = new Map();
    this.stepResults = new Map();
    this.responseRevealed = new Set();
    this.variables = new Map();
    this.credentials = new CredentialManager(walkthrough.credentials || {});

    if (walkthrough.namespace) {
      FeatureManager.setDefaultNamespace(walkthrough.namespace);
    }
    FeatureManager.setGatewayRef({
      name: EDITION_GATEWAY_NAME[this.edition],
      namespace: FeatureManager.getDefaultNamespace(),
    });
  }

  get currentScreen() {
    return this.walkthrough.screens[this.screenIndex];
  }

  get currentStep() {
    return this.currentScreen.steps[this.stepIndex];
  }

  resultKey(screenIndex = this.screenIndex, stepIndex = this.stepIndex) {
    return `${screenIndex}:${stepIndex}`;
  }

  /** @returns {?object} the stored result for a step, or null if it hasn't run yet */
  getStepResult(screenIndex, stepIndex) {
    return this.stepResults.get(this.resultKey(screenIndex, stepIndex)) ?? null;
  }

  /** @returns {?string} the YAML applied for a screen's setup, or null if it hasn't been applied/captured */
  getAppliedYaml(screenIndex = this.screenIndex) {
    return this.appliedYaml.get(screenIndex) ?? null;
  }

  isResponseRevealed(screenIndex = this.screenIndex, stepIndex = this.stepIndex) {
    return this.responseRevealed.has(this.resultKey(screenIndex, stepIndex));
  }

  /**
   * Applies every screen's setup from index 0 through `index` that hasn't been applied yet, in
   * one PolicyRegistry enable -> deploy -> commit -> disable envelope - the same single envelope
   * UseCaseManager.deploy() wraps its own whole deploy in, applied at the equivalent "one batch"
   * granularity (one call here = one deploy). Features within this one batch that target the
   * same policy ref get coalesced into one applied object; a batch that spans a jump over several
   * screens still coalesces across all of them. A screen's `teardown` runs before its own `setup`.
   */
  async ensureAppliedThrough(index) {
    PolicyRegistry.enable();
    try {
      for (let i = 0; i <= index; i++) {
        if (this.appliedScreens.has(i)) continue;
        const screen = this.walkthrough.screens[i];

        for (const featureRef of screen.teardown || []) {
          await FeatureManager.cleanup(
            featureRef.name,
            { ...(featureRef.config || {}), spinner: SILENT_SPINNER },
            { edition: this.edition }
          );
        }

        const docs = [];
        for (const featureRef of screen.setup || []) {
          const config = featureRef.config || {};
          // Snapshot PolicyRegistry's coalesced state before the dry-run capture call below,
          // and restore it right after: that call runs with PolicyRegistry still enabled for
          // this whole batch, so a policy-emitting feature's applyResource() registers into
          // the same policies/contributors maps as the real deploy call that follows it. Without
          // reverting, the dry-run call's registration double-counts this feature as its own
          // contributor, corrupting the committed resource's name/labels (e.g.
          // "merged-<name>-<name>-..." instead of "<name>-...").
          const policiesBeforePreview = new Map(PolicyRegistry.policies);
          const contributorsBeforePreview = new Map(PolicyRegistry.contributors);
          try {
            // Best-effort only, for the "Applied Configuration" preview panel - a feature whose
            // dry-run isn't side-effect-pure must not block the real deploy below. A feature that
            // emits a policy resource also legitimately captures nothing here: PolicyRegistry
            // defers policy resources out of _dryRunYaml while enabled.
            const rendered = await FeatureManager.deploy(featureRef.name, config, {
              dryRun: true,
              edition: this.edition,
            });
            docs.push(...(rendered || []));
          } catch {
            // see above
          } finally {
            PolicyRegistry.policies = policiesBeforePreview;
            PolicyRegistry.contributors = contributorsBeforePreview;
          }
          await FeatureManager.deploy(featureRef.name, config, {
            edition: this.edition,
            spinner: SILENT_SPINNER,
          });
        }
        if (docs.length > 0)
          this.appliedYaml.set(i, docs.map(doc => doc.trim()).join('\n\n---\n\n'));
        this.appliedScreens.add(i);
      }

      if (PolicyRegistry.getMergedPolicyCount() > 0) {
        await PolicyRegistry.commit({ spinner: SILENT_SPINNER });
      }
    } finally {
      PolicyRegistry.disable();
    }
  }

  /**
   * Clears a screen's cached step results and applied-setup state if it's already been visited
   * before, so re-entering it re-runs its teardown/setup and re-fires every step fresh instead of
   * silently replaying stale results. A no-op for a screen that's never been applied yet.
   */
  resetIfRevisited(screenIndex) {
    if (!this.appliedScreens.has(screenIndex)) return;
    this.appliedScreens.delete(screenIndex);
    this.appliedYaml.delete(screenIndex);
    const screen = this.walkthrough.screens[screenIndex];
    for (let stepIndex = 0; stepIndex < screen.steps.length; stepIndex++) {
      const key = this.resultKey(screenIndex, stepIndex);
      this.stepResults.delete(key);
      this.responseRevealed.delete(key);
    }
  }

  /** Jumps directly to a screen, applying cumulative setup through it first. */
  async jumpToScreen(index) {
    if (index < 0 || index >= this.walkthrough.screens.length) return;
    this.resetIfRevisited(index);
    this.emit('running');
    await this.ensureAppliedThrough(index);
    this.screenIndex = index;
    this.stepIndex = 0;
    this.emit('change');
  }

  /**
   * Builds and stores an 'http' step's request (resolving any credential) without firing it -
   * so the TUI can show the request before the step actually runs.
   */
  async previewCurrentStep() {
    this.emit('running');
    const request = await buildHttpRequest(this.currentStep, {
      credentials: this.credentials,
      variables: this.variables,
    });
    this.stepResults.set(this.resultKey(), { kind: 'http', request });
    this.emit('change');
  }

  /**
   * Fires the current step and stores its result, revealing the response immediately. An
   * 'http' step reuses its already-built preview's request rather than re-resolving the
   * credential a second time.
   */
  async runCurrentStep() {
    const key = this.resultKey();
    this.emit('running');
    const result =
      this.currentStep.kind === 'http'
        ? await executeHttpRequest(this.currentStep, this.stepResults.get(key).request)
        : await runStep(this.currentStep, {
            credentials: this.credentials,
            variables: this.variables,
          });
    this.stepResults.set(key, result);
    this.responseRevealed.add(key);
    this.emit('change');
    return result;
  }

  /**
   * Stores a prompt step's submitted value as a named variable (later steps substitute it via
   * {{vars.NAME}} in headers), reveals the result, and lets a subsequent right-arrow advance.
   */
  submitPromptValue(value) {
    const { variableName } = this.currentStep;
    this.variables.set(variableName, value);
    const key = this.resultKey();
    this.stepResults.set(key, { kind: 'prompt', variableName, value });
    this.responseRevealed.add(key);
    this.emit('change');
  }

  /**
   * Moves to the next step, or crosses into the next screen at a screen's end. Crossing a
   * screen boundary only moves the indices - it deliberately does NOT apply the new screen's
   * setup yet, so its narration shows first; the next right-arrow press is what applies setup.
   */
  async advance() {
    const steps = this.currentScreen.steps;
    if (this.stepIndex < steps.length - 1) {
      this.stepIndex += 1;
      this.emit('change');
      return;
    }
    if (this.screenIndex < this.walkthrough.screens.length - 1) {
      const nextIndex = this.screenIndex + 1;
      this.resetIfRevisited(nextIndex);
      this.screenIndex = nextIndex;
      this.stepIndex = 0;
      this.emit('change');
    }
  }

  /** Moves to the previous step, crossing back into the previous screen's last step at a screen's start. */
  retreat() {
    if (this.stepIndex > 0) {
      this.stepIndex -= 1;
      this.emit('change');
      return;
    }
    if (this.screenIndex > 0) {
      const previous = this.walkthrough.screens[this.screenIndex - 1];
      this.screenIndex -= 1;
      this.stepIndex = previous.steps.length - 1;
      this.emit('change');
    }
  }

  /**
   * Right-arrow: for an 'http' step, applying a screen's setup, previewing the request (built
   * but not sent), firing it (which reveals the response), and advancing are four separate
   * presses. A 'prompt' step has nothing to fire here - submitPromptValue (via Enter) drives it.
   * Other step kinds fire directly on their first press.
   */
  async handleRight() {
    if (!this.appliedScreens.has(this.screenIndex)) {
      this.emit('running');
      await this.ensureAppliedThrough(this.screenIndex);
      this.emit('change');
      return;
    }

    const current = this.stepResults.get(this.resultKey());
    const isHttp = this.currentStep.kind === 'http';
    const isPrompt = this.currentStep.kind === 'prompt';

    if (!current) {
      if (isHttp) {
        await this.previewCurrentStep();
      } else if (isPrompt) {
        return;
      } else {
        await this.runCurrentStep();
      }
      return;
    }

    if (isHttp && current.status === undefined) {
      await this.runCurrentStep();
      return;
    }

    await this.advance();
  }

  /** Left-arrow: always moves backward. */
  async handleLeft() {
    this.retreat();
  }
}

import { render } from 'ink';
import React from 'react';
import { WalkthroughManager } from './walkthroughs.js';
import { WalkthroughEngine } from './walkthrough-engine.js';
import { FeatureManager } from './feature.js';
import { WalkthroughApp } from '../tui/WalkthroughApp.js';
import { AgentGatewayManager } from './agentgateway.js';
import { ProfileManager } from './profiles.js';
import { Logger, KubernetesHelper } from './common.js';

async function loadEngine(name) {
  const walkthroughs = await WalkthroughManager.list();
  const match = walkthroughs.find(w => w.name === name);
  if (!match) {
    throw new Error(`Walkthrough '${name}' not found. Run: agw walkthrough list`);
  }
  const walkthrough = await WalkthroughManager.load(match.file);
  return new WalkthroughEngine(walkthrough);
}

/**
 * Resolves the agentgateway chart version from the profile recorded by the last successful
 * `base install`, for display in the walkthrough header - returns null (header omits itself)
 * on any failure, e.g. an unreachable cluster or no recorded install state.
 * @returns {Promise<?string>}
 */
export async function resolveInstalledAgentgatewayVersion() {
  try {
    const profileName = await AgentGatewayManager.getInstalledProfile();
    if (!profileName) return null;

    const profiles = await ProfileManager.list();
    const match = profiles.find(profile => profile.name === profileName);
    if (!match) return null;

    const profile = await ProfileManager.load(match.file);
    return profile.agentgateway?.version || null;
  } catch {
    return null;
  }
}

/** Pre-provisions the walkthrough's dependencies, then renders it full-screen. */
export async function runWalkthrough(name) {
  const engine = await loadEngine(name);

  for (const featureRef of engine.walkthrough.preProvision) {
    await FeatureManager.deploy(featureRef.name, featureRef.config || {}, {
      edition: engine.edition,
    });
  }
  const installedVersion = await resolveInstalledAgentgatewayVersion();
  const { waitUntilExit } = render(
    React.createElement(WalkthroughApp, { engine, installedVersion }),
    {
      alternateScreen: true,
    }
  );
  try {
    await waitUntilExit();
  } catch (error) {
    // Ink's alternate-screen teardown restores the primary buffer before this runs, which
    // discards whatever was drawn in the alt-screen - printing the full stack here (not just
    // error.message) is the only way a crash during rendering stays visible instead of
    // silently reverting to a blank prompt.
    console.error(error.stack || error.message);
    throw error;
  }
}

/**
 * Deletes every merged EnterpriseAgentgatewayPolicy resource PolicyRegistry.commit() created
 * while this walkthrough ran. A per-feature cleanup() can only delete a policy by that feature's
 * OWN expected name, never the renamed `<feature>-<target>`/`merged-<a>-<b>-<target>` object
 * PolicyRegistry.commit() actually applies, so those resources are otherwise orphaned and keep
 * being enforced. Mirrors UseCaseManager.cleanup()'s equivalent sweep (src/lib/usecase.js) -
 * duplicated rather than shared, since this plan's Non-Goals exclude changing UseCaseManager.
 * Best-effort: never throws, only warns.
 */
async function cleanupMergedPolicies() {
  try {
    const result = await KubernetesHelper.kubectl(
      [
        'get',
        'enterpriseagentgatewaypolicy',
        '-n',
        FeatureManager.getDefaultNamespace(),
        '-l',
        'agentgateway.dev/merged-policy=true',
        '-o',
        'jsonpath={.items[*].metadata.name}',
      ],
      { ignoreError: true }
    );

    if (result.exitCode !== 0) {
      Logger.warn(
        `Failed to list merged EnterpriseAgentgatewayPolicy resources for cleanup: ${result.stderr?.trim() || `exit code ${result.exitCode}`}`
      );
      return;
    }

    const policyNames = result.stdout.trim().split(/\s+/).filter(Boolean);
    for (const policyName of policyNames) {
      const deleteResult = await KubernetesHelper.kubectl(
        [
          'delete',
          'enterpriseagentgatewaypolicy',
          policyName,
          '-n',
          FeatureManager.getDefaultNamespace(),
          '--ignore-not-found=true',
        ],
        { ignoreError: true }
      );
      if (deleteResult.exitCode !== 0) {
        Logger.warn(
          `Failed to delete merged policy '${policyName}': ${deleteResult.stderr?.trim() || `exit code ${deleteResult.exitCode}`}`
        );
      }
    }
  } catch (error) {
    Logger.warn(`Merged-policy cleanup failed: ${error.message}`);
  }
}

/** Cleans up every feature a walkthrough's screens and pre-provisioning applied, in reverse order. */
export async function cleanWalkthrough(name) {
  const engine = await loadEngine(name);
  const allFeatureRefs = [
    ...engine.walkthrough.preProvision,
    ...engine.walkthrough.screens.flatMap(screen => screen.setup || []),
  ];
  for (const featureRef of [...allFeatureRefs].reverse()) {
    try {
      await FeatureManager.cleanup(featureRef.name, featureRef.config || {}, {
        edition: engine.edition,
      });
    } catch (error) {
      Logger.warn(`Failed to clean up feature '${featureRef.name}': ${error.message}`);
    }
  }
  await cleanupMergedPolicies();
}

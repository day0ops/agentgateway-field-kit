import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';
import { WalkthroughManager } from '../../src/lib/walkthroughs.js';
import { AgentGatewayManager } from '../../src/lib/agentgateway.js';
import { ProfileManager } from '../../src/lib/profiles.js';
import {
  cleanWalkthrough,
  resolveInstalledAgentgatewayVersion,
} from '../../src/lib/walkthrough-runner.js';

class RecordingFeature extends Feature {
  async deploy() {
    RecordingFeature.deployed.push(this.name);
  }
  async cleanup() {
    RecordingFeature.cleanedUp.push(this.name);
  }
}
RecordingFeature.deployed = [];
RecordingFeature.cleanedUp = [];

class RecordingFeatureA extends RecordingFeature {}
class RecordingFeatureB extends RecordingFeature {}
class RecordingFeatureC extends RecordingFeature {}

let originalFeatures, root, originalWalkthroughsDir, originalKubectl;

beforeEach(() => {
  RecordingFeature.deployed = [];
  RecordingFeature.cleanedUp = [];
  originalFeatures = FeatureManager.features;
  FeatureManager.features = new Map();
  FeatureManager.register('feature-a', RecordingFeatureA);
  FeatureManager.register('feature-b', RecordingFeatureB);
  FeatureManager.register('feature-c', RecordingFeatureC);
  root = mkdtempSync(join(tmpdir(), 'agw-walkthrough-runner-test-'));
  originalWalkthroughsDir = WalkthroughManager.WALKTHROUGHS_DIR;
  WalkthroughManager.WALKTHROUGHS_DIR = join(root, 'config', 'walkthroughs');

  // cleanWalkthrough's merged-policy sweep calls KubernetesHelper.kubectl - default to a no-op
  // success (nothing to sweep) so tests that don't care about it never reach a real cluster.
  originalKubectl = KubernetesHelper.kubectl;
  KubernetesHelper.kubectl = async () => ({ exitCode: 0, stdout: '', stderr: '' });
});

afterEach(() => {
  FeatureManager.features = originalFeatures;
  WalkthroughManager.WALKTHROUGHS_DIR = originalWalkthroughsDir;
  KubernetesHelper.kubectl = originalKubectl;
  rmSync(root, { recursive: true, force: true });
});

describe('cleanWalkthrough', () => {
  test("cleans up preProvision and every screen's setup, in reverse order", async () => {
    mkdirSync(WalkthroughManager.WALKTHROUGHS_DIR, { recursive: true });
    writeFileSync(
      join(WalkthroughManager.WALKTHROUGHS_DIR, 'demo.yaml'),
      [
        'apiVersion: agentgateway.demo/v1',
        'kind: Walkthrough',
        'metadata:',
        '  name: demo',
        'spec:',
        '  preProvision:',
        '    - name: feature-a',
        '  screens:',
        '    - name: one',
        '      setup:',
        '        - name: feature-b',
        '      steps: []',
        '    - name: two',
        '      setup:',
        '        - name: feature-c',
        '      steps: []',
        '',
      ].join('\n')
    );

    await cleanWalkthrough('demo');

    // preProvision (feature-a) + screen one (feature-b) + screen two (feature-c),
    // cleaned up in reverse: feature-c, feature-b, feature-a
    expect(RecordingFeature.cleanedUp).toEqual(['feature-c', 'feature-b', 'feature-a']);
  });

  test('throws a clear error when the named walkthrough does not exist', async () => {
    mkdirSync(WalkthroughManager.WALKTHROUGHS_DIR, { recursive: true });
    await expect(cleanWalkthrough('missing')).rejects.toThrow(/not found/);
  });
});

describe('cleanWalkthrough merged-policy sweep', () => {
  function writeMinimalWalkthrough() {
    mkdirSync(WalkthroughManager.WALKTHROUGHS_DIR, { recursive: true });
    writeFileSync(
      join(WalkthroughManager.WALKTHROUGHS_DIR, 'demo.yaml'),
      [
        'apiVersion: agentgateway.demo/v1',
        'kind: Walkthrough',
        'metadata:',
        '  name: demo',
        'spec:',
        '  screens:',
        '    - name: one',
        '      setup:',
        '        - name: feature-a',
        '      steps: []',
        '',
      ].join('\n')
    );
  }

  test('deletes every merged EnterpriseAgentgatewayPolicy left over, after the per-feature cleanup loop', async () => {
    writeMinimalWalkthrough();
    const calls = [];
    KubernetesHelper.kubectl = async args => {
      calls.push(args);
      if (args[0] === 'get') {
        return {
          exitCode: 0,
          stdout: 'merged-feature-a-feature-b-routing-basic policy-feature-c-routing-basic',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await cleanWalkthrough('demo');

    // feature-a's own cleanup() runs first (it only knows its own expected name, which never
    // matches the renamed merged object), then the sweep deletes both leftover policies by name.
    expect(RecordingFeature.cleanedUp).toEqual(['feature-a']);
    const deleteCalls = calls.filter(args => args[0] === 'delete');
    expect(deleteCalls.map(args => args[2])).toEqual([
      'merged-feature-a-feature-b-routing-basic',
      'policy-feature-c-routing-basic',
    ]);
    expect(deleteCalls.every(args => args.includes('--ignore-not-found=true'))).toBe(true);
  });

  test('is a no-op when there are no merged policies to sweep', async () => {
    writeMinimalWalkthrough();
    const deleteCalls = [];
    KubernetesHelper.kubectl = async args => {
      if (args[0] === 'delete') deleteCalls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await cleanWalkthrough('demo');

    expect(deleteCalls).toEqual([]);
  });

  test('warns but does not throw when the sweep fails entirely (e.g. unreachable cluster)', async () => {
    writeMinimalWalkthrough();
    KubernetesHelper.kubectl = async () => {
      throw new Error('cluster unreachable');
    };

    await expect(cleanWalkthrough('demo')).resolves.toBeUndefined();
    // The per-feature cleanup loop still ran despite the sweep's failure.
    expect(RecordingFeature.cleanedUp).toEqual(['feature-a']);
  });
});

describe('resolveInstalledAgentgatewayVersion', () => {
  let originalGetInstalledProfile, originalProfileList, originalProfileLoad;

  beforeEach(() => {
    originalGetInstalledProfile = AgentGatewayManager.getInstalledProfile;
    originalProfileList = ProfileManager.list;
    originalProfileLoad = ProfileManager.load;
  });

  afterEach(() => {
    AgentGatewayManager.getInstalledProfile = originalGetInstalledProfile;
    ProfileManager.list = originalProfileList;
    ProfileManager.load = originalProfileLoad;
  });

  test("returns the installed profile's agentgateway.version", async () => {
    AgentGatewayManager.getInstalledProfile = async () => 'local-single-cluster';
    ProfileManager.list = async () => [{ name: 'local-single-cluster', file: '/fake/path.yaml' }];
    ProfileManager.load = async () => ({ agentgateway: { version: 'v2026.11.0' } });

    expect(await resolveInstalledAgentgatewayVersion()).toBe('v2026.11.0');
  });

  test('returns null when no profile is recorded', async () => {
    AgentGatewayManager.getInstalledProfile = async () => null;
    expect(await resolveInstalledAgentgatewayVersion()).toBeNull();
  });

  test('returns null when any lookup throws (e.g. unreachable cluster)', async () => {
    AgentGatewayManager.getInstalledProfile = async () => {
      throw new Error('cluster unreachable');
    };
    expect(await resolveInstalledAgentgatewayVersion()).toBeNull();
  });
});

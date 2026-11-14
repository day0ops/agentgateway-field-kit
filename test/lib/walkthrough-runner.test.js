import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Feature, FeatureManager } from '../../src/lib/feature.js';
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

let originalFeatures, root, originalWalkthroughsDir;

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
});

afterEach(() => {
  FeatureManager.features = originalFeatures;
  WalkthroughManager.WALKTHROUGHS_DIR = originalWalkthroughsDir;
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

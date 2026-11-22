import { test, expect, describe } from 'bun:test';
import { ProfileManager } from '../../src/lib/profiles.js';

const BUMPED = [
  'agentgateway-with-keycloak',
  'eks-enterprise-agentgateway-complete',
  'eks-enterprise-agentgateway-minimal',
  'eks-enterprise-agentgateway-lts-complete',
  'eks-enterprise-agentgateway-lts-minimal',
  'local-single-cluster',
];

const UNCHANGED = [['agentgateway-custom-version', '2.1.1']];

describe('agentgateway version bump scope', () => {
  for (const name of BUMPED) {
    test(`${name} is pinned to v2026.11.1`, async () => {
      const profile = await ProfileManager.load(`${ProfileManager.PROFILES_DIR}/${name}.yaml`);
      expect(profile.agentgateway.version).toBe('v2026.11.1');
      expect(profile['agentgateway-crds'].version).toBe('v2026.11.1');
    });
  }

  for (const [name, expectedVersion] of UNCHANGED) {
    test(`${name} stays pinned to ${expectedVersion}`, async () => {
      const profile = await ProfileManager.load(`${ProfileManager.PROFILES_DIR}/${name}.yaml`);
      expect(profile.agentgateway.version).toBe(expectedVersion);
    });
  }

  test('eks-opensource-agentgateway stays on its own versioning scheme', async () => {
    const profile = await ProfileManager.load(
      `${ProfileManager.PROFILES_DIR}/eks-opensource-agentgateway.yaml`
    );
    expect(profile.agentgateway.version).toBe('1.6.0');
  });
});

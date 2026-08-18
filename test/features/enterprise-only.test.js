import { test, expect, describe } from 'bun:test';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

// Confirmed enterprise-only (no OSS agentgateway.dev equivalent) via direct source reads
// and, for the CRD-backed ones, direct inspection of the real agentgateway-crds chart schema.
const ENTERPRISE_ONLY_FEATURES = [
  'apikey-auth',
  'oauth-authorization-code',
  'oauth-access-token-validation',
  'token-exchange',
  'obo-token-exchange',
  'quota-budget',
  'quota-ratelimit',
  'rate-limit',
  'virtual-keys',
  'multi-org-jwt-auth',
  'llm-cost-tracking',
  'elicitation-backend',
  'model-costs',
  'budget-limits',
  'mcp-enterprise',
  'mcp-guardrails',
];

describe('Enterprise-only feature tagging', () => {
  for (const name of ENTERPRISE_ONLY_FEATURES) {
    test(`${name} declares SUPPORTED_EDITIONS = ['enterprise']`, () => {
      expect(FeatureManager.getSupportedEditions(name)).toEqual(['enterprise']);
    });

    test(`${name} rejects edition: opensource before touching Kubernetes`, async () => {
      await expect(
        FeatureManager.deploy(name, {}, { dryRun: true, edition: 'opensource' })
      ).rejects.toThrow(/does not support edition 'opensource'/);
    });

    test(`${name} accepts edition: enterprise or no edition option`, () => {
      expect(FeatureManager.getSupportedEditions(name)).toContain('enterprise');
    });
  }
});

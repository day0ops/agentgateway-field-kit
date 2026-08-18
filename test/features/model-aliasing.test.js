import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

describe('ModelAliasingFeature dry-run', () => {
  test('includes the embedded provider secret, not just its own backend/route', async () => {
    const docs = await FeatureManager.deploy(
      'model-aliasing',
      {
        namespace: 'agentgateway-system',
        provider: 'openai',
        aliases: { fast: 'gpt-4o-mini' },
      },
      { dryRun: true }
    );
    const kinds = docs.map(d => yaml.load(d).kind);
    expect(kinds).toContain('Secret');
    expect(kinds).toContain('EnterpriseAgentgatewayBackend');
    expect(kinds).toContain('HTTPRoute');
  });
});

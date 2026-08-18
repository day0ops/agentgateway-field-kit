import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const config = {
  namespace: 'agentgateway-system',
  action: 'Allow',
  expressions: ["request.headers['x-tier'] == 'premium'", "token.claims['role'] == 'admin'"],
};

describe('CelBasedRbacFeature edition branching', () => {
  test('enterprise (default) emits EnterpriseAgentgatewayPolicy with action + matchExpressions', async () => {
    const docs = await FeatureManager.deploy('cel-based-rbac', config, { dryRun: true });
    expect(docs.length).toBe(1);
    const policy = yaml.load(docs[0]);

    expect(policy.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(policy.kind).toBe('EnterpriseAgentgatewayPolicy');
    expect(policy.spec.traffic.authorization.action).toBe('Allow');
    expect(policy.spec.traffic.authorization.policy.matchExpressions).toEqual(config.expressions);
  });

  test('edition: enterprise resolves identically to omitting the edition option', async () => {
    const withoutEdition = await FeatureManager.deploy('cel-based-rbac', config, { dryRun: true });
    const withEnterprise = await FeatureManager.deploy('cel-based-rbac', config, {
      dryRun: true,
      edition: 'enterprise',
    });
    expect(withoutEdition).toEqual(withEnterprise);
  });

  test('edition: opensource emits AgentgatewayPolicy with the same action + matchExpressions shape', async () => {
    const docs = await FeatureManager.deploy('cel-based-rbac', config, {
      dryRun: true,
      edition: 'opensource',
    });
    expect(docs.length).toBe(1);
    const policy = yaml.load(docs[0]);

    expect(policy.apiVersion).toBe('agentgateway.dev/v1alpha1');
    expect(policy.kind).toBe('AgentgatewayPolicy');
    expect(policy.spec.traffic.authorization.action).toBe('Allow');
    expect(policy.spec.traffic.authorization.policy.matchExpressions).toEqual(config.expressions);
  });

  test('edition: opensource preserves action: Deny', async () => {
    const docs = await FeatureManager.deploy(
      'cel-based-rbac',
      { ...config, action: 'Deny', expressions: ["request.headers['x-blocked'] == 'true'"] },
      { dryRun: true, edition: 'opensource' }
    );
    const policy = yaml.load(docs[0]);
    expect(policy.spec.traffic.authorization.action).toBe('Deny');
    expect(policy.spec.traffic.authorization.policy.matchExpressions).toEqual([
      "request.headers['x-blocked'] == 'true'",
    ]);
  });
});

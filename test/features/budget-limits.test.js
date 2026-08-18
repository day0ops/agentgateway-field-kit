import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';
import { BudgetLimitsFeature } from '../../features/budget-limits/index.js';

const budgets = [
  {
    name: 'bob-daily-tokens',
    subject: { virtualKey: 'bob' },
    limit: { unit: 'Tokens', amount: 1 },
    window: { unit: 'Day' },
    onBudgetExceeded: 'Block',
  },
  {
    name: 'alice-daily-tokens',
    subject: { virtualKey: 'alice' },
    limit: { unit: 'Tokens', amount: 1 },
    window: { unit: 'Day' },
    onBudgetExceeded: 'Audit',
  },
];

describe('BudgetLimitsFeature', () => {
  test('EnterpriseAgentgatewayBudget.spec.budgets matches input', async () => {
    const docs = await FeatureManager.deploy('budget-limits', { budgets }, { dryRun: true });
    const budgetDoc = docs
      .map(d => yaml.load(d))
      .find(d => d?.kind === 'EnterpriseAgentgatewayBudget');

    expect(budgetDoc).toBeTruthy();
    expect(budgetDoc.spec.budgets).toEqual(budgets);
  });

  test('policy traffic.entBudgetEnforcement/discovery/apiKeyAuthentication shape is correct', async () => {
    const docs = await FeatureManager.deploy(
      'budget-limits',
      {
        budgets,
        discovery: { namespaces: { from: 'All' } },
        apiKeyAuth: { mode: 'Strict', secretRef: { name: 'virtual-keys' } },
      },
      { dryRun: true }
    );
    const policyDoc = docs
      .map(d => yaml.load(d))
      .find(d => d?.kind === 'EnterpriseAgentgatewayPolicy');

    expect(policyDoc).toBeTruthy();
    expect(policyDoc.spec.traffic.entBudgetEnforcement).toEqual({
      discovery: { namespaces: { from: 'All' } },
    });
    expect(policyDoc.spec.traffic.apiKeyAuthentication).toEqual({
      mode: 'Strict',
      secretRef: { name: 'virtual-keys' },
    });
  });

  test('policy omits apiKeyAuthentication and discovery when not configured', async () => {
    const docs = await FeatureManager.deploy('budget-limits', { budgets }, { dryRun: true });
    const policyDoc = docs
      .map(d => yaml.load(d))
      .find(d => d?.kind === 'EnterpriseAgentgatewayPolicy');

    expect(policyDoc.spec.traffic.apiKeyAuthentication).toBeUndefined();
    expect(policyDoc.spec.traffic.entBudgetEnforcement).toEqual({});
  });

  test('onBudgetExceeded defaults to Block when omitted', async () => {
    const docs = await FeatureManager.deploy(
      'budget-limits',
      {
        budgets: [
          {
            name: 'x',
            subject: { virtualKey: '*' },
            limit: { unit: 'Tokens', amount: 10 },
            window: { unit: 'Day' },
          },
        ],
      },
      { dryRun: true }
    );
    const budgetDoc = docs
      .map(d => yaml.load(d))
      .find(d => d?.kind === 'EnterpriseAgentgatewayBudget');
    expect(budgetDoc.spec.budgets[0].onBudgetExceeded).toBe('Block');
  });

  test('validate() throws when more than 64 budgets are configured', () => {
    const tooMany = Array.from({ length: 65 }, (_, i) => ({
      name: `b${i}`,
      subject: { virtualKey: '*' },
      limit: { unit: 'Tokens', amount: 1 },
      window: { unit: 'Day' },
    }));
    const feature = new BudgetLimitsFeature('budget-limits', { budgets: tooMany });
    expect(() => feature.validate()).toThrow(/at most 64 budgets/);
  });

  test('validate() throws on duplicate budget names', () => {
    const feature = new BudgetLimitsFeature('budget-limits', {
      budgets: [
        {
          name: 'dup',
          subject: { virtualKey: 'a' },
          limit: { unit: 'Tokens', amount: 1 },
          window: { unit: 'Day' },
        },
        {
          name: 'dup',
          subject: { virtualKey: 'b' },
          limit: { unit: 'Tokens', amount: 1 },
          window: { unit: 'Day' },
        },
      ],
    });
    expect(() => feature.validate()).toThrow(/duplicate budget name/);
  });

  test('validate() throws on a bad limit.unit', () => {
    const feature = new BudgetLimitsFeature('budget-limits', {
      budgets: [
        {
          name: 'bad-unit',
          subject: { virtualKey: '*' },
          limit: { unit: 'Dollars', amount: 1 },
          window: { unit: 'Day' },
        },
      ],
    });
    expect(() => feature.validate()).toThrow(/limit.unit must be one of Tokens, USD/);
  });

  test('validate() throws when no budgets are configured', () => {
    const feature = new BudgetLimitsFeature('budget-limits', { budgets: [] });
    expect(() => feature.validate()).toThrow(/at least one budget is required/);
  });
});

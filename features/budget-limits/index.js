import { Feature, FeatureManager } from '../../src/lib/feature.js';

const DEFAULT_BUDGETS_RESOURCE_NAME = 'budget-limits';
const DEFAULT_POLICY_NAME = 'budget-enforcement';
const MAX_BUDGETS = 64;
const LIMIT_UNITS = ['Tokens', 'USD'];
const WINDOW_UNITS = ['Day', 'Week', 'Month', 'Year'];
const EXCEEDED_ACTIONS = ['Block', 'Audit'];

/**
 * Budget Limits Feature
 *
 * Implements Solo's native "Budget and spend limits" capability: an EnterpriseAgentgatewayBudget
 * (up to 64 entries, scoped by subject dimensions such as virtualKey/model/provider/user/group)
 * enforced via EnterpriseAgentgatewayPolicy.traffic.entBudgetEnforcement. Uses the enterprise
 * chart's built-in rate-limit service and Redis - no custom infrastructure required.
 *
 * This is the feature new use cases should use instead of the deprecated 'quota-budget' /
 * 'quota-ratelimit' features.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/llm/cost-controls/budget-limits/
 *
 * Configuration:
 * {
 *   budgets: [{                  // 1-64 entries, unique names
 *     name: string,
 *     subject: Record<string, string>,   // e.g. { virtualKey: '*' }, { user: 'alice' }
 *     limit: { unit: 'Tokens'|'USD', amount: number },  // amount: positive integer
 *     window: { unit: 'Day'|'Week'|'Month'|'Year' },
 *     onBudgetExceeded: 'Block'|'Audit',  // default: 'Block'
 *   }],
 *   budgetsResourceName: string,  // Default: 'budget-limits'
 *   policyName: string,           // Default: 'budget-enforcement'
 *   targetRefs: Array<{ group?: string, kind?: string, name: string }>, // Default: the Gateway
 *   discovery: {                  // Optional EnterpriseAgentgatewayPolicy.traffic.entBudgetEnforcement.discovery
 *     namespaces: { from: 'Same'|'Selector'|'All', selector?: { matchLabels: Record<string,string> } }
 *   },
 *   apiKeyAuth: object,           // Optional traffic.apiKeyAuthentication block for standalone use
 *                                 // (omit when a separate auth feature, e.g. virtual-keys/apikey-auth,
 *                                 // already targets the same object - PolicyRegistry merges both).
 * }
 */
export class BudgetLimitsFeature extends Feature {
  // Enterprise-only: EnterpriseAgentgatewayBudget/entBudgetEnforcement has no OSS equivalent.
  static SUPPORTED_EDITIONS = ['enterprise'];

  constructor(name, config) {
    super(name, config);
    this.budgetsResourceName = config.budgetsResourceName || DEFAULT_BUDGETS_RESOURCE_NAME;
    this.policyName = config.policyName || DEFAULT_POLICY_NAME;
    this.discovery = config.discovery || null;
    this.apiKeyAuth = config.apiKeyAuth || null;
  }

  get targetRefs() {
    if (this.config.targetRefs) {
      return this.config.targetRefs.map(ref => ({
        group: ref.group || 'gateway.networking.k8s.io',
        kind: ref.kind || 'Gateway',
        name: ref.name,
      }));
    }
    const gatewayRef = FeatureManager.getGatewayRef();
    return [{ group: 'gateway.networking.k8s.io', kind: 'Gateway', name: gatewayRef.name }];
  }

  get normalizedBudgets() {
    return (this.config.budgets || []).map(budget => ({
      ...budget,
      onBudgetExceeded: budget.onBudgetExceeded || 'Block',
    }));
  }

  validate() {
    const budgets = this.config.budgets;
    if (!Array.isArray(budgets) || budgets.length === 0) {
      throw new Error('budget-limits: at least one budget is required');
    }
    if (budgets.length > MAX_BUDGETS) {
      throw new Error(`budget-limits: at most ${MAX_BUDGETS} budgets are allowed`);
    }

    const seenNames = new Set();
    for (const budget of budgets) {
      if (!budget.name) {
        throw new Error('budget-limits: each budget requires a name');
      }
      if (seenNames.has(budget.name)) {
        throw new Error(`budget-limits: duplicate budget name '${budget.name}'`);
      }
      seenNames.add(budget.name);

      if (!LIMIT_UNITS.includes(budget.limit?.unit)) {
        throw new Error(
          `budget-limits: budget '${budget.name}' limit.unit must be one of ${LIMIT_UNITS.join(', ')}`
        );
      }
      if (!Number.isInteger(budget.limit?.amount) || budget.limit.amount <= 0) {
        throw new Error(
          `budget-limits: budget '${budget.name}' limit.amount must be a positive integer`
        );
      }
      if (!WINDOW_UNITS.includes(budget.window?.unit)) {
        throw new Error(
          `budget-limits: budget '${budget.name}' window.unit must be one of ${WINDOW_UNITS.join(', ')}`
        );
      }
      if (budget.onBudgetExceeded && !EXCEEDED_ACTIONS.includes(budget.onBudgetExceeded)) {
        throw new Error(
          `budget-limits: budget '${budget.name}' onBudgetExceeded must be one of ${EXCEEDED_ACTIONS.join(', ')}`
        );
      }
    }
    return true;
  }

  async deploy() {
    this.log('Deploying budget limits...', 'info');

    await this._deployBudgetResource();
    await this._deployEnforcementPolicy();
    this._warnIfUsdBudgetsPresent();

    this.log('Budget limits deployed', 'success');
  }

  async _deployBudgetResource() {
    const budgets = this.normalizedBudgets;
    await this.applyYamlFile('budget.yaml', {
      metadata: { name: this.budgetsResourceName, namespace: this.namespace },
      spec: { budgets },
    });
    this.log(
      `EnterpriseAgentgatewayBudget '${this.budgetsResourceName}' applied with ${budgets.length} budget(s)`,
      'info'
    );
  }

  async _deployEnforcementPolicy() {
    const entBudgetEnforcement = {};
    if (this.discovery) entBudgetEnforcement.discovery = this.discovery;

    const traffic = { entBudgetEnforcement };
    if (this.apiKeyAuth) traffic.apiKeyAuthentication = this.apiKeyAuth;

    await this.applyYamlFile('enterprise-agentgateway-policy.yaml', {
      metadata: { name: this.policyName, namespace: this.namespace },
      spec: { targetRefs: this.targetRefs, traffic },
    });
    this.log(
      `EnterpriseAgentgatewayPolicy '${this.policyName}' targeting ${this.targetRefs.map(r => r.name).join(', ')}`,
      'info'
    );
  }

  _warnIfUsdBudgetsPresent() {
    const hasUsdBudget = this.normalizedBudgets.some(b => b.limit?.unit === 'USD');
    if (hasUsdBudget) {
      this.log(
        "USD-denominated budget(s) configured - pair this use case with the 'model-costs' feature " +
          '(EnterpriseAgentgatewayParameters.modelCatalog) so requests are priced. This feature does ' +
          'not verify that a model cost catalog is attached to the Gateway.',
        'warn'
      );
    }
  }

  async cleanup() {
    this.log('Cleaning up budget limits...', 'info');

    await this.deleteResource('EnterpriseAgentgatewayPolicy', this.policyName);
    await this.deleteResource('EnterpriseAgentgatewayBudget', this.budgetsResourceName);

    this.log('Budget limits cleaned up', 'success');
  }
}

export function createBudgetLimitsFeature(config) {
  return new BudgetLimitsFeature('budget-limits', config);
}

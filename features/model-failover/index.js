import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';
import { ProvidersFeature } from '../providers/index.js';
import { BACKEND_API_GROUP, BACKEND_KIND } from '../../src/lib/editions.js';

/**
 * Model Failover Feature
 *
 * Implements automatic failover between multiple LLM providers and models
 * using the AgentgatewayBackend resource with priority groups (spec.ai.groups).
 *
 * This feature is self-contained:
 * - Validates required environment variables for provider API keys
 * - Creates Kubernetes secrets for provider authentication
 * - Creates an AgentgatewayBackend (agentgateway.dev/v1alpha1) with groups configuration
 * - Organizes providers into priority groups (higher number = higher priority)
 * - Creates an HTTPRoute that routes requests to the failover backend
 * - Optionally reuses existing AgentgatewayBackend resources when they exist
 *
 * Provider-specific logic (LLM config, secrets, auth policies) is delegated
 * to ProvidersFeature so there is a single source of truth.
 *
 * Reference: https://kgateway.dev/docs/agentgateway/latest/llm/failover/
 *
 * Configuration:
 * {
 *   pathPrefix: string,        // Optional: HTTP path prefix (default: '/model')
 *   providers: [
 *     {
 *       name: string,          // Provider type name (openai, anthropic, vertex-ai, etc.)
 *       model: string,         // Optional: Model to use
 *       priority: number,      // Optional: Priority level (default: 100, higher = tried first)
 *       location: string,      // Optional: Region/location for Vertex AI
 *       region: string,        // Optional: AWS region for Bedrock
 *       authMode: string,      // Optional: Bedrock only — 'credentials' for AWS keys
 *     }
 *   ]
 * }
 */
export class ModelFailoverFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.pathPrefix = config.pathPrefix || '/model';
    this.providers = config.providers || [];

    this._providerHelper = new ProvidersFeature(name, {
      providers: [],
      namespace: config.namespace,
      dryRun: config.dryRun,
    });
  }

  getFeaturePath() {
    return this.name;
  }

  validate() {
    if (!this.providers || this.providers.length === 0) {
      throw new Error('No providers specified for model-failover feature');
    }

    for (const provider of this.providers) {
      if (!provider.name) {
        throw new Error('All providers must have a name');
      }
    }

    return true;
  }

  async deploy() {
    this.log('Configuring model failover backend...', 'info');
    this._providerHelper.setSpinner(this.spinner);

    const providerLookups = {};
    for (const p of this.providers) {
      if (!providerLookups[p.name]) {
        providerLookups[p.name] = await this.getProviderBackendConfig(p.name);
      }
    }

    await this.ensureSecrets(providerLookups);

    const groups = this.buildGroupsConfig(providerLookups);
    await this.createBackend(groups);
    await this.createHTTPRoute();

    this.log(`Model failover configured at ${this.pathPrefix}`, 'info');
  }

  async cleanup() {
    await this.deleteResource('HTTPRoute', 'model-failover');
    await this.deleteResource(BACKEND_KIND[this.edition], 'model-failover', this.namespace);

    const cleaned = new Set();
    for (const p of this.providers) {
      if (!cleaned.has(p.name)) {
        const secretName = ModelFailoverFeature.getSecretName(p.providerName || p.name);
        await this.deleteResource('Secret', secretName);
        cleaned.add(p.name);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Secrets — delegates to ProvidersFeature
  // ---------------------------------------------------------------------------

  async ensureSecrets(providerLookups) {
    const created = new Set();

    for (const p of this.providers) {
      if (created.has(p.name)) continue;
      created.add(p.name);

      const lookup = providerLookups[p.name];
      if (lookup.llm && Object.keys(lookup.llm).length > 0) continue;

      if (!this.dryRun) {
        const envVars = this._providerHelper.getRequiredEnvVars(p);
        const missing = envVars.filter(v => !process.env[v]);
        if (missing.length > 0) {
          throw new Error(
            `Missing environment variable(s) for provider '${p.name}': ${missing.join(', ')}`
          );
        }
      }

      await this._providerHelper.createProviderSecret({
        ...p,
        providerName: p.providerName || p.name,
      });
    }
  }

  static getSecretName(providerName) {
    if (providerName === 'gemini') return 'google-secret';
    if (providerName === 'bedrock') return 'bedrock-secret';
    return `${providerName}-secret`;
  }

  // ---------------------------------------------------------------------------
  // Provider Backend lookup
  // ---------------------------------------------------------------------------

  async getProviderBackendConfig(providerName) {
    try {
      const backendPlural = `${BACKEND_KIND[this.edition].toLowerCase()}s.${BACKEND_API_GROUP[this.edition]}`;
      const result = await KubernetesHelper.kubectl(
        ['get', backendPlural, providerName, '-n', this.namespace, '-o', 'json'],
        { ignoreError: true }
      );

      if (result.exitCode !== 0 || !result.stdout) {
        return { name: providerName };
      }

      const backend = JSON.parse(result.stdout);
      return {
        name: providerName,
        llm: backend.spec?.ai?.provider || {},
        auth: backend.spec?.policies?.auth || null,
      };
    } catch (error) {
      return { name: providerName };
    }
  }

  // ---------------------------------------------------------------------------
  // Groups config — uses ProvidersFeature for LLM config + auth
  // ---------------------------------------------------------------------------

  buildGroupsConfig(providerLookups) {
    const priorityBuckets = {};

    for (const p of this.providers) {
      const priority = p.priority || 100;
      if (!priorityBuckets[priority]) priorityBuckets[priority] = [];
      priorityBuckets[priority].push(p);
    }

    const sortedPriorities = Object.keys(priorityBuckets)
      .map(p => parseInt(p))
      .sort((a, b) => b - a);

    return sortedPriorities.map(priority => ({
      providers: priorityBuckets[priority].map(p =>
        this.buildNamedProvider(providerLookups[p.name], p)
      ),
    }));
  }

  buildNamedProvider(backendConfig, overrides) {
    const baseName = overrides.name || backendConfig.name;
    const model = overrides.model;

    const uniqueName = model
      ? `${baseName}-${model}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
      : baseName;

    const namedProvider = { name: uniqueName };
    const hasLookedUpConfig = backendConfig.llm && Object.keys(backendConfig.llm).length > 0;

    if (hasLookedUpConfig) {
      for (const providerType in backendConfig.llm) {
        const config = backendConfig.llm[providerType];
        if (!config) continue;
        namedProvider[providerType] = { ...config };
        if (model) namedProvider[providerType].model = model;
        break;
      }
    } else {
      const llmConfig = this._providerHelper.getBackendLLMConfig({
        ...overrides,
        providerName: overrides.providerName || baseName,
      });
      Object.assign(namedProvider, llmConfig);
    }

    const policies = {};

    if (backendConfig.auth) {
      policies.auth = backendConfig.auth;
    } else if (!hasLookedUpConfig) {
      const providerType = overrides.providerName || baseName;
      const secretName = ModelFailoverFeature.getSecretName(providerType);
      const authPolicy = this._providerHelper.getBackendAuthPolicy(
        providerType,
        secretName,
        overrides
      );
      if (authPolicy && Object.keys(authPolicy).length > 0) {
        policies.auth = authPolicy;
      }
    }

    if (overrides.policies) {
      if (overrides.policies.auth) policies.auth = overrides.policies.auth;
      if (overrides.policies.ai) policies.ai = overrides.policies.ai;
    }

    const aiPolicy = ProvidersFeature.mergeAiPolicy(baseName, overrides.model, policies.ai);
    if (aiPolicy) policies.ai = aiPolicy;

    if (Object.keys(policies).length > 0) {
      namedProvider.policies = policies;
    }

    return namedProvider;
  }

  // ---------------------------------------------------------------------------
  // Kubernetes resources
  // ---------------------------------------------------------------------------

  async createBackend(groups) {
    const overrides = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: 'model-failover',
        namespace: this.namespace,
        labels: { 'agentgateway.dev/feature': 'model-failover' },
      },
      spec: {
        ai: { groups, provider: undefined },
        policies: undefined,
      },
    };

    await this.applyYamlFile('backend.yaml', overrides);
    this.log(`${BACKEND_KIND[this.edition]} created for model-failover`, 'info');
  }

  async createHTTPRoute() {
    const gatewayRef = FeatureManager.getGatewayRef();
    const overrides = {
      metadata: {
        name: 'model-failover',
        namespace: this.namespace,
        labels: { 'agentgateway.dev/feature': 'model-failover' },
      },
      spec: {
        parentRefs: [{ name: gatewayRef.name, namespace: gatewayRef.namespace }],
        rules: [
          {
            matches: [{ path: { value: this.pathPrefix } }],
            backendRefs: [
              {
                name: 'model-failover',
                namespace: this.namespace,
                group: BACKEND_API_GROUP[this.edition],
                kind: BACKEND_KIND[this.edition],
              },
            ],
          },
        ],
      },
    };

    await this.applyYamlFile('httproute.yaml', overrides);
    this.log(`HTTPRoute created for model-failover at ${this.pathPrefix}`, 'info');
  }
}

export function createModelFailoverFeature(config) {
  return new ModelFailoverFeature('model-failover', config);
}

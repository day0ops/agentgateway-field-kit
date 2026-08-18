import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { ProvidersFeature } from '../providers/index.js';
import { BACKEND_API_GROUP, BACKEND_KIND } from '../../src/lib/editions.js';

/**
 * Load Balancing Feature
 *
 * Distributes requests across multiple LLM providers using Power of Two Choices (P2C).
 * All providers are placed in a single group — no priority = P2C algorithm selects
 * the best backend based on health, latency, and pending requests.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/llm/load-balancing/
 *
 * Configuration:
 * {
 *   providers: [
 *     {
 *       name: string,       // Provider type (openai, anthropic, vertex-ai, etc.)
 *       model: string,      // Optional: model to use
 *       location: string,   // Optional: GCP region for vertex-ai
 *       region: string,     // Optional: AWS region for bedrock
 *       authMode: string,   // Optional: bedrock auth mode
 *     }
 *   ],
 *   pathPrefix: string,     // HTTP path prefix (default: '/model')
 * }
 */
export class LoadBalancingFeature extends Feature {
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

  validate() {
    if (!this.providers || this.providers.length < 2) {
      throw new Error('load-balancing: at least 2 providers required for load balancing');
    }
    for (const p of this.providers) {
      if (!p.name) throw new Error('load-balancing: each provider must have a name');
    }
    return true;
  }

  static _getSecretName(providerName) {
    if (providerName === 'gemini') return 'google-secret';
    if (providerName === 'vertex-ai') return 'vertex-ai-secret';
    if (providerName === 'bedrock') return 'bedrock-secret';
    return `${providerName}-secret`;
  }

  async deploy() {
    this.log('Configuring load balancing backend...', 'info');
    this._providerHelper.setSpinner(this.spinner);

    // Create secrets for all unique provider types
    const created = new Set();
    for (const p of this.providers) {
      if (created.has(p.name)) continue;
      created.add(p.name);
      if (!this.dryRun) {
        const envVars = this._providerHelper.getRequiredEnvVars({ ...p, providerName: p.name });
        const missing = envVars.filter(v => !process.env[v]);
        if (missing.length > 0) {
          throw new Error(`Missing env var(s) for provider '${p.name}': ${missing.join(', ')}`);
        }
      }
      await this._providerHelper.createProviderSecret({ ...p, providerName: p.name });
    }

    // Build all providers into a single group (P2C — no priority field)
    const namedProviders = this.providers.map(p => {
      const llmConfig = this._providerHelper.getBackendLLMConfig({ ...p, providerName: p.name });
      const secretName = LoadBalancingFeature._getSecretName(p.name);
      const authPolicy = this._providerHelper.getBackendAuthPolicy(p.name, secretName, {
        ...p,
        providerName: p.name,
      });
      const model = p.model;
      const uniqueName = model
        ? `${p.name}-${model}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
        : p.name;
      const entry = { name: uniqueName, ...llmConfig };
      if (authPolicy && Object.keys(authPolicy).length > 0) {
        entry.policies = { auth: authPolicy };
      }
      return entry;
    });

    const gatewayRef = FeatureManager.getGatewayRef();

    await this.applyYamlFile('backend.yaml', {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: 'load-balancing',
        namespace: this.namespace,
        labels: { 'agentgateway.dev/feature': 'load-balancing' },
      },
      spec: {
        ai: { groups: [{ providers: namedProviders }] },
      },
    });

    await this.applyYamlFile('httproute.yaml', {
      metadata: {
        name: 'load-balancing',
        namespace: this.namespace,
        labels: { 'agentgateway.dev/feature': 'load-balancing' },
      },
      spec: {
        parentRefs: [{ name: gatewayRef.name, namespace: gatewayRef.namespace }],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: this.pathPrefix } }],
            backendRefs: [
              {
                name: 'load-balancing',
                namespace: this.namespace,
                group: BACKEND_API_GROUP[this.edition],
                kind: BACKEND_KIND[this.edition],
              },
            ],
          },
        ],
      },
    });

    this.log(
      `Load balancing configured at ${this.pathPrefix} with ${this.providers.length} providers (P2C)`,
      'success'
    );
  }

  async cleanup() {
    await this.deleteResource('HTTPRoute', 'load-balancing');
    await this.deleteResource(BACKEND_KIND[this.edition], 'load-balancing', this.namespace);
    const cleaned = new Set();
    for (const p of this.providers) {
      if (cleaned.has(p.name)) continue;
      cleaned.add(p.name);
      await this.deleteResource('Secret', LoadBalancingFeature._getSecretName(p.name));
    }
  }
}

export function createLoadBalancingFeature(config) {
  return new LoadBalancingFeature('load-balancing', config);
}

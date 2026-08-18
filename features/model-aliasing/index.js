import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { ProvidersFeature } from '../providers/index.js';
import { BACKEND_API_GROUP, BACKEND_KIND } from '../../src/lib/editions.js';

/**
 * Model Aliasing Feature
 *
 * Maps user-friendly alias names to actual LLM provider model identifiers.
 * Clients send e.g. "model": "fast" and agentgateway translates to the real model.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/llm/alias/
 *
 * Configuration:
 * {
 *   provider: string,              // Provider type: openai, anthropic, vertex-ai, etc.
 *   model: string,                 // Optional: default model when no alias matches
 *   aliases: { [alias]: string },  // Map of alias name → real model name
 *   pathPrefix: string,            // HTTP path prefix (default: '/model')
 * }
 */
export class ModelAliasingFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.pathPrefix = config.pathPrefix || '/model';
    this._providerHelper = new ProvidersFeature(name, {
      providers: [],
      namespace: config.namespace,
      dryRun: config.dryRun,
    });
    this._providerHelper.adoptParentContext(this);
  }

  validate() {
    if (!this.config.provider) {
      throw new Error('model-aliasing: provider is required');
    }
    if (!this.config.aliases || Object.keys(this.config.aliases).length === 0) {
      throw new Error('model-aliasing: aliases must have at least one entry');
    }
    return true;
  }

  async deploy() {
    this.log('Configuring model aliasing...', 'info');
    this._providerHelper.setSpinner(this.spinner);

    const { provider, model, aliases } = this.config;

    // Create provider secret if needed
    if (!this.dryRun) {
      const envVars = this._providerHelper.getRequiredEnvVars({
        name: provider,
        providerName: provider,
      });
      const missing = envVars.filter(v => !process.env[v]);
      if (missing.length > 0) {
        throw new Error(`Missing env var(s) for provider '${provider}': ${missing.join(', ')}`);
      }
    }
    await this._providerHelper.createProviderSecret({
      name: provider,
      providerName: provider,
      model,
    });

    // Build provider LLM config and auth policy
    const llmConfig = this._providerHelper.getBackendLLMConfig({
      name: provider,
      providerName: provider,
      model,
    });
    const secretName = ModelAliasingFeature._getSecretName(provider);
    const authPolicy = this._providerHelper.getBackendAuthPolicy(provider, secretName, {
      name: provider,
      providerName: provider,
    });
    const gatewayRef = FeatureManager.getGatewayRef();

    await this.applyYamlFile('backend.yaml', {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: 'model-aliasing',
        namespace: this.namespace,
        labels: { 'agentgateway.dev/feature': 'model-aliasing' },
      },
      spec: {
        ai: { provider: llmConfig },
        policies: {
          auth: authPolicy && Object.keys(authPolicy).length > 0 ? authPolicy : undefined,
          ai: { modelAliases: aliases },
        },
      },
    });

    await this.applyYamlFile('httproute.yaml', {
      metadata: {
        name: 'model-aliasing',
        namespace: this.namespace,
        labels: { 'agentgateway.dev/feature': 'model-aliasing' },
      },
      spec: {
        parentRefs: [{ name: gatewayRef.name, namespace: gatewayRef.namespace }],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: this.pathPrefix } }],
            backendRefs: [
              {
                name: 'model-aliasing',
                namespace: this.namespace,
                group: BACKEND_API_GROUP[this.edition],
                kind: BACKEND_KIND[this.edition],
              },
            ],
          },
        ],
      },
    });

    this.log(`Model aliasing configured at ${this.pathPrefix}`, 'success');
  }

  static _getSecretName(providerName) {
    if (providerName === 'gemini') return 'google-secret';
    if (providerName === 'vertex-ai') return 'vertex-ai-secret';
    if (providerName === 'bedrock') return 'bedrock-secret';
    return `${providerName}-secret`;
  }

  async cleanup() {
    await this.deleteResource('HTTPRoute', 'model-aliasing');
    await this.deleteResource(BACKEND_KIND[this.edition], 'model-aliasing', this.namespace);
    const secretName = ModelAliasingFeature._getSecretName(this.config.provider);
    await this.deleteResource('Secret', secretName);
  }
}

export function createModelAliasingFeature(config) {
  return new ModelAliasingFeature('model-aliasing', config);
}

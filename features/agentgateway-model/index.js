import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { ProvidersFeature } from '../providers/index.js';

// AgentgatewayModel ships under agentgateway.dev/v1alpha1 in OSS and
// enterpriseagentgateway.solo.io/v1alpha1 in enterprise docs/builds. Verified live against the
// enterprise-agentgateway-crds chart version this repo pins - it registers the CRD under
// agentgateway.dev, so that's the group used here (not the enterpriseagentgateway.solo.io group
// shown in the Solo enterprise docs).
const MODEL_GROUP = 'agentgateway.dev';
const MODEL_API_VERSION = `${MODEL_GROUP}/v1alpha1`;

// spec.provider enum values this feature knows how to configure. Both providers here need
// nothing beyond `transformations` (to rewrite the outbound model name) + policies.auth.secretRef
// (provider API key) - confirmed against this repo's own AgentgatewayBackend usage, where
// anthropic/openai both only ever need `{ model }` (unlike vertex-ai/bedrock/azure, which need
// project/region/endpoint fields whose AgentgatewayModel-level shape isn't confirmed yet - so
// they're intentionally not supported here until that's verified against a real CRD schema).
const PROVIDER_ENUM = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/**
 * AgentgatewayModel Feature
 *
 * Builds `AgentgatewayModel` resources (`agentgateway.dev/v1alpha1`), the
 * experimental model-centric API that replaces the AgentgatewayBackend+HTTPRoute pattern used
 * by every other feature in this repo. Each model attaches directly to a Gateway listener and
 * gets built-in OpenAI-compatible paths and `/v1/models` discovery - no HTTPRoute needed.
 *
 * Requires the experimental AgentgatewayModel CRD/API enabled on the cluster
 * (`agentgatewayModels.enabled=true` on the control plane chart, `installAgentgatewayModelCRD=true`
 * on the CRD chart) and a Gateway listener whose `allowedRoutes.kinds` includes AgentgatewayModel.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/llm/models/about/
 *
 * Configuration:
 * {
 *   sectionName: string,        // Gateway listener sectionName (default: 'http')
 *   models: [{
 *     name: string,                        // metadata.name; also the client-facing name when match is omitted
 *     match: string,                       // optional client-facing name/wildcard pattern (spec.match.model)
 *     visibility: 'Public' | 'Internal',   // default 'Public'
 *     provider: 'openai' | 'anthropic',    // concrete model only (mutually exclusive w/ virtualModel)
 *     transformations: [{ field, expression }],  // optional, e.g. stripPrefix
 *     health: {                            // optional, spec.policies.health (eviction for failover)
 *       unhealthyCondition: string,        // CEL expression, e.g. 'true' to evict after every response
 *       eviction: { consecutiveFailures: number, duration?: string },
 *     },
 *     virtualModel: {                      // OR virtual model (mutually exclusive w/ provider)
 *       weighted: { targets: [{ name, weight }] },
 *       conditional: { targets: [{ when?, name }] },  // last entry with no `when` = fallback
 *       failover: { targets: [{ name, priority }] },  // lower priority number = preferred
 *     },
 *   }],
 * }
 */
export class AgentgatewayModelFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.sectionName = config.sectionName || 'http';
    this.models = config.models || [];
    this._providerHelper = new ProvidersFeature(name, {
      providers: [],
      namespace: config.namespace,
      dryRun: config.dryRun,
    });
    // Share the same dryRun YAML collector: _providerHelper is a separate Feature instance,
    // so without this, secrets it creates via applyResource() would land in its own isolated
    // _dryRunYaml array instead of the one FeatureManager.deploy() actually returns.
    if (this.dryRun) {
      this._providerHelper._dryRunYaml = this._dryRunYaml;
    }
  }

  validate() {
    if (this.models.length === 0) {
      throw new Error('agentgateway-model: at least one model is required');
    }

    for (const model of this.models) {
      if (!model.name) {
        throw new Error('agentgateway-model: each model requires a name');
      }

      const hasProvider = !!model.provider;
      const hasVirtual = !!model.virtualModel;
      if (hasProvider === hasVirtual) {
        throw new Error(
          `agentgateway-model: model '${model.name}' must set exactly one of provider or virtualModel`
        );
      }

      if (hasProvider && !PROVIDER_ENUM[model.provider]) {
        throw new Error(
          `agentgateway-model: unsupported provider '${model.provider}' for model '${model.name}' ` +
            `(supported: ${Object.keys(PROVIDER_ENUM).join(', ')})`
        );
      }

      if (hasVirtual) {
        const { weighted, conditional, failover } = model.virtualModel;
        const strategyCount = [weighted, conditional, failover].filter(Boolean).length;
        if (strategyCount !== 1) {
          throw new Error(
            `agentgateway-model: virtualModel for '${model.name}' must set exactly one of weighted, conditional, or failover`
          );
        }
      }
    }

    return true;
  }

  async deploy() {
    this.log('Configuring AgentgatewayModel resources...', 'info');
    this._providerHelper.setSpinner(this.spinner);

    const gatewayRef = FeatureManager.getGatewayRef();
    const secretsCreated = new Set();

    for (const model of this.models) {
      if (model.provider) {
        await this.ensureProviderSecret(model.provider, secretsCreated);
        await this.applyConcreteModel(model, gatewayRef);
      } else {
        await this.applyVirtualModel(model, gatewayRef);
      }
    }

    this.log('AgentgatewayModel resources configured', 'success');
  }

  async ensureProviderSecret(providerName, secretsCreated) {
    if (secretsCreated.has(providerName)) return;
    secretsCreated.add(providerName);

    if (!this.dryRun) {
      const envVars = this._providerHelper.getRequiredEnvVars({
        name: providerName,
        providerName,
      });
      const missing = envVars.filter(v => !process.env[v]);
      if (missing.length > 0) {
        throw new Error(`Missing env var(s) for provider '${providerName}': ${missing.join(', ')}`);
      }
    }
    await this._providerHelper.createProviderSecret({ name: providerName, providerName });
  }

  buildParentRefs(gatewayRef) {
    return [
      {
        group: 'gateway.networking.k8s.io',
        kind: 'Gateway',
        name: gatewayRef.name,
        namespace: gatewayRef.namespace,
        sectionName: this.sectionName,
      },
    ];
  }

  async applyConcreteModel(model, gatewayRef) {
    const spec = { parentRefs: this.buildParentRefs(gatewayRef) };
    if (model.match) spec.match = { model: model.match };
    spec.visibility = model.visibility || 'Public';
    spec.provider = PROVIDER_ENUM[model.provider];
    spec.policies = { auth: { secretRef: { name: `${model.provider}-secret` } } };
    if (model.transformations) spec.policies.transformations = model.transformations;
    if (model.health) spec.policies.health = model.health;

    await this.applyResource({
      apiVersion: MODEL_API_VERSION,
      kind: 'AgentgatewayModel',
      metadata: {
        name: model.name,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec,
    });
    this.log(`AgentgatewayModel '${model.name}' created (provider: ${model.provider})`, 'info');
  }

  async applyVirtualModel(model, gatewayRef) {
    const { weighted, conditional, failover } = model.virtualModel;
    let virtualModel;
    if (weighted) {
      virtualModel = {
        weighted: {
          targets: weighted.targets.map(t => ({
            modelRef: { name: t.name },
            weight: t.weight,
          })),
        },
      };
    } else if (conditional) {
      virtualModel = {
        conditional: {
          targets: conditional.targets.map(t => ({
            ...(t.when ? { when: t.when } : {}),
            modelRef: { name: t.name },
          })),
        },
      };
    } else {
      virtualModel = {
        failover: {
          targets: failover.targets.map(t => ({
            modelRef: { name: t.name },
            priority: t.priority,
          })),
        },
      };
    }

    await this.applyResource({
      apiVersion: MODEL_API_VERSION,
      kind: 'AgentgatewayModel',
      metadata: {
        name: model.name,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        parentRefs: this.buildParentRefs(gatewayRef),
        // Virtual models must be Public and cannot set spec.policies.
        visibility: 'Public',
        virtualModel,
      },
    });
    this.log(`AgentgatewayModel '${model.name}' created (virtual model)`, 'info');
  }

  async cleanup() {
    for (const model of this.models) {
      await this.deleteResource('AgentgatewayModel', model.name, this.namespace);
    }
    const providersUsed = new Set(this.models.filter(m => m.provider).map(m => m.provider));
    for (const providerName of providersUsed) {
      await this.deleteResource('Secret', `${providerName}-secret`, this.namespace);
    }
  }
}

export function createAgentgatewayModelFeature(config) {
  return new AgentgatewayModelFeature('agentgateway-model', config);
}

import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { Logger, KubernetesHelper } from '../../src/lib/common.js';
import {
  EDITION_GATEWAY_NAME,
  BACKEND_API_GROUP,
  BACKEND_KIND,
  policyApiVersion,
  POLICY_KIND,
} from '../../src/lib/editions.js';

/**
 * Providers Feature
 *
 * Configures LLM providers for agentgateway with complete AgentgatewayBackend and HTTPRoute setup.
 * This feature:
 * - Creates Kubernetes secrets for provider API keys and credentials
 * - Creates AgentgatewayBackend resources for each provider
 * - Creates HTTPRoute resources with configurable path prefixes
 * - Supports multiple LLM providers (OpenAI, Anthropic, Azure, Gemini, Bedrock, etc.)
 * - Validates required environment variables
 *
 * Reference: https://kgateway.dev/docs/latest/agentgateway/llm/providers/
 *
 * Configuration (two modes):
 *
 * Mode 1: Single providers (backward compatible):
 * {
 *   providers: [
 *     {
 *       name: string,              // Provider identifier (used as Backend resource name)
 *       providerName: string,      // Optional: Actual provider type (openai, vertex-ai, etc.)
 *                                  // If not specified, defaults to name. Used for secret naming.
 *       pathPrefix: string,        // Optional: HTTP path prefix (default: '/provider-name')
 *       model: string,             // Optional: Default model to use
 *       region: string,            // Optional: AWS region for Bedrock (default: 'us-east-1')
 *       endpoint: string,          // Azure OpenAI: resource endpoint (default: AZURE_OPENAI_ENDPOINT env var)
 *       deploymentName: string,    // Azure OpenAI: deployment name (default: model)
 *       apiVersion: string,        // Azure OpenAI: API version (default: 'v1')
 *       authMode: string,          // Optional: 'none' = no auth, client headers pass through; 'passthrough' = use Authorization header; 'credentials' = Bedrock auth.aws.secretRef; default = auth.secretRef (API key)
 *       upstreamRewrite: {         // Optional: redirect to a raw upstream host+path instead of the
 *         hostname: string,        //   backend's own configured model/path (e.g. a model-specific
 *         path: string,            //   Bedrock invoke endpoint). Combine with policies.ai.routes
 *       },                         //   Passthrough so the request body isn't reshaped.
 *       // ... provider-specific options
 *     }
 *   ]
 * }
 *
 * Mode 2: Groups (priority groups with optional multiple providers per group):
 * - Multiple groups: list order = failover priority (first group highest).
 * - Multiple providers in one group: load balanced within that group.
 * {
 *   groups: [
 *     {
 *       name: string,              // Optional: Group name (for identification)
 *       providers: [               // One or more providers in this group (load balanced within group)
 *         {
 *           name: string,          // Free-form identifier (used as SectionName in NamedLLMProvider)
 *           providerName: string,   // Actual provider type (openai, vertex-ai, etc.) - used for secret naming
 *           model: string,         // Optional: Model to use
 *           // ... provider-specific options (same as Mode 1)
 *           policies: {            // Optional: Per-provider policies (overrides group-level)
 *             auth: {
 *               secretRef: {
 *                 name: string     // Secret name for authentication
 *               }
 *             },
 *             ai: {                // Optional: AI-specific policies (BackendAI)
 *               promptEnrichment: {
 *                 prepend: [...],  // Messages to prepend
 *                 append: [...]    // Messages to append
 *               },
 *               promptGuard: {
 *                 request: {...},  // Request guardrails
 *                 response: {...}  // Response guardrails
 *               }
 *             }
 *           }
 *         }
 *       ],
 *       policies: {                // Optional: Group-level policies (applies to all providers unless overridden)
 *         auth: {
 *           secretRef: {
 *             name: string         // Secret name for authentication
 *           }
 *         },
 *         ai: {                     // Optional: AI-specific policies (BackendAI)
 *           promptEnrichment: {
 *             prepend: [...],      // Messages to prepend
 *             append: [...]         // Messages to append
 *           },
 *           promptGuard: {
 *             request: {...},       // Request guardrails
 *             response: {...}      // Response guardrails
 *           }
 *         }
 *       }
 *     }
 *   ],
 *   pathPrefix: string            // Optional: HTTP path prefix (default: '/providers')
 * }
 *
 * Simple configuration (backward compatible):
 * {
 *   providers: ['openai', 'bedrock']  // Uses defaults
 * }
 *
 * Required environment variables by provider:
 * - OpenAI: OPENAI_API_KEY
 * - Anthropic: ANTHROPIC_API_KEY
 * - Azure OpenAI: AZURE_OPENAI_API_KEY (AZURE_OPENAI_ENDPOINT optional)
 * - Gemini: GEMINI_API_KEY
 * - Bedrock (authMode=credentials): AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (AWS_SESSION_TOKEN optional)
 * - Bedrock (authMode!=credentials): AWS_BEDROCK_API_KEY
 * - Vertex AI: GOOGLE_APPLICATION_CREDENTIALS
 * - OpenAI-compatible: OPENAI_COMPATIBLE_API_KEY
 */
export class ProvidersFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    // Check if using groups mode or single providers mode
    this.useGroups = !!config.groups;

    // Capture the gateway ref at construction time (set by prior feature like sidecar-agent).
    // This ensures cleanup uses the same gateway context as deploy.
    this.deployGatewayRef = FeatureManager.getGatewayRef();

    if (this.useGroups) {
      this.groups = config.groups || [];
      this.pathPrefix = config.pathPrefix || '/providers';
    } else {
      // Normalize providers to objects with configuration (backward compatible)
      this.normalizedProviders = this.normalizeProviders(config.providers || []);
      this.bodyRouting = !!config.bodyRouting;
      this.bodyRoutingFallback =
        this.bodyRouting && this.normalizedProviders.some(p => p.fallbackModel); // failover only when fallbackModel(s) exist
      this.queryParamRouting = !!config.queryParamRouting;
      this.queryParamName = config.queryParamName || 'model';
      this.singleRoute = this.bodyRouting || this.queryParamRouting || !!config.singleRoute;
      this.pathPrefix = config.pathPrefix || '/chat';
      // Derive unique resource names from pathPrefix so multiple instances don't collide
      const pathKey =
        this.pathPrefix.replace(/\//g, '-').replace(/^-/, '').replace(/-$/, '') || 'default';
      this.routeName = `providers-${pathKey}-route`;
      this.policyName = `body-routing-policy-${pathKey}`;
      this.fallbackBackendName = `providers-fallback-${pathKey}`;
    }
  }

  getFeaturePath() {
    return this.name;
  }

  /**
   * Get a resource name, prefixed with gateway name if not default.
   * This ensures unique resource names when multiple gateways use the same provider.
   */
  getResourceName(baseName) {
    const defaultGatewayName = EDITION_GATEWAY_NAME[this.edition];
    const gatewayName = this.deployGatewayRef?.name || defaultGatewayName;
    if (gatewayName === defaultGatewayName) {
      return baseName;
    }
    return `${gatewayName}-${baseName}`;
  }

  /**
   * Normalize providers from simple strings or objects
   */
  normalizeProviders(providers) {
    return providers.map(provider => {
      if (typeof provider === 'string') {
        // Simple string format: convert to object with defaults
        // In single provider mode, name and providerName are the same
        return {
          name: provider,
          providerName: provider, // providerName defaults to name for backward compatibility
          pathPrefix: `/${provider}`,
          model: this.getDefaultModel(provider),
          region: provider === 'bedrock' ? 'us-east-1' : undefined,
        };
      } else {
        // Object format: fill in defaults; preserve authMode, guardrail, policies, etc.
        // providerName is the actual provider type (openai, vertex-ai, etc.)
        // name is the free-form identifier (used as SectionName in groups mode)
        const providerName = provider.providerName || provider.name;
        const base = {
          name: provider.name,
          providerName,
          pathPrefix: provider.pathPrefix || `/${provider.name}`,
          model: provider.model || undefined,
          region: provider.region || undefined,
          location: provider.location || undefined,
          authMode: provider.authMode, // Bedrock: 'credentials' => auth.aws.secretRef
          modelMatch: provider.modelMatch, // 'RegularExpression' for regex header matching in body routing
          fallbackModel: provider.fallbackModel, // concrete model name for the failover groups backend
          ...(provider.guardrail ? { guardrail: provider.guardrail } : {}),
          ...(provider.policies ? { policies: provider.policies } : {}),
          ...(provider.pathRewrite != null ? { pathRewrite: provider.pathRewrite } : {}),
          ...(provider.hostname ? { hostname: provider.hostname } : {}),
          ...(provider.upstreamRewrite ? { upstreamRewrite: provider.upstreamRewrite } : {}),
          ...(provider.endpoint ? { endpoint: provider.endpoint } : {}), // Azure OpenAI
          ...(provider.deploymentName ? { deploymentName: provider.deploymentName } : {}), // Azure OpenAI
          ...(provider.apiVersion ? { apiVersion: provider.apiVersion } : {}), // Azure OpenAI
        };
        if (providerName === 'openai-compatible') {
          return { ...base, ...this.applyOpenAICompatibleDefaults(provider) };
        }
        return base;
      }
    });
  }

  /**
   * Defaults for openai-compatible provider (e.g. local Ollama). User can override via config or endpoint/env.
   */
  static getOpenAICompatibleDefaults() {
    return {
      host: 'localhost',
      port: 11434,
      path: { full: '/v1/chat/completions' },
    };
  }

  /**
   * Apply openai-compatible defaults to a provider config; user values override.
   */
  applyOpenAICompatibleDefaults(config) {
    const defaults = ProvidersFeature.getOpenAICompatibleDefaults();
    return {
      ...defaults,
      ...config,
      path: config.path ? { ...defaults.path, ...config.path } : defaults.path,
    };
  }

  /**
   * Get default model for a provider
   */
  getDefaultModel(providerName) {
    const defaults = {
      openai: 'gpt-4',
      anthropic: 'claude-3-sonnet-20240229',
      'azure-openai': 'gpt-4',
      bedrock: 'global.amazon.nova-2-lite-v1:0',
      gemini: 'google/gemini-2.5-flash',
      'vertex-ai': 'google/gemini-2.5-flash',
      'openai-compatible': '',
    };
    return defaults[providerName] || '';
  }

  validate() {
    if (this.useGroups) {
      if (!this.groups || this.groups.length === 0) {
        throw new Error('No groups specified for providers feature');
      }

      // Validate each group has providers
      for (const group of this.groups) {
        if (!group.providers || group.providers.length === 0) {
          throw new Error('Each group must have at least one provider');
        }
      }

      // Check for duplicate provider names (free-form identifiers) across groups
      // name is used as SectionName in NamedLLMProvider and must be unique
      const providerNames = new Set();
      for (const group of this.groups) {
        for (const provider of group.providers) {
          const config = typeof provider === 'string' ? { name: provider } : provider;
          const providerName = config.name; // Use name (free-form identifier) for uniqueness check
          if (providerNames.has(providerName)) {
            throw new Error(
              `Provider name '${providerName}' must be unique across all groups (used as SectionName)`
            );
          }
          providerNames.add(providerName);
        }
      }
    } else {
      if (this.normalizedProviders.length === 0) {
        throw new Error('No providers specified for providers feature');
      }
    }

    return true;
  }

  async deploy() {
    if (this.useGroups) {
      await this.deployGroups();
    } else {
      await this.deploySingleProviders();
    }
  }

  /**
   * Deploy providers using groups mode
   */
  async deployGroups() {
    // Collect all providers from all groups to validate env vars
    const allProviders = [];
    for (const group of this.groups) {
      for (const provider of group.providers) {
        const providerConfig = typeof provider === 'string' ? { name: provider } : provider;
        // providerName is the actual provider type (openai, vertex-ai, etc.) used for secrets
        // name is the free-form identifier used as SectionName
        const providerName = providerConfig.providerName || providerConfig.name;
        allProviders.push({
          name: providerConfig.name, // Free-form identifier
          providerName: providerName, // Actual provider type
          config: providerConfig,
        });
      }
    }

    // Validate environment variables (skip in dry-run; placeholders will be used)
    if (!this.dryRun) {
      const missingEnvVars = [];
      for (const { providerName, config } of allProviders) {
        const requiredVars = this.getRequiredEnvVars(config);
        for (const envVar of requiredVars) {
          if (!process.env[envVar]) {
            missingEnvVars.push({ provider: providerName, envVar });
          }
        }
      }

      if (missingEnvVars.length > 0) {
        const errorMessages = missingEnvVars.map(
          ({ provider, envVar }) => `  - ${provider}: ${envVar} not set`
        );
        throw new Error(
          `Missing required environment variables for providers:\n${errorMessages.join('\n')}\n\n` +
            `Please set the required environment variables before deploying.`
        );
      }
    }

    // Create secrets for all providers (use providerName for secret naming); skip when no auth required (e.g. openai-compatible with no policies.auth.secretRef)
    const createdSecrets = new Set();
    for (const { providerName, config } of allProviders) {
      if (!createdSecrets.has(providerName)) {
        if (this.getRequiredEnvVars(config).length === 0) {
          createdSecrets.add(providerName);
          continue;
        }
        if (providerName === 'bedrock' && config.authMode === 'credentials') {
          await this.createBedrockSecret();
        } else if (providerName === 'bedrock') {
          await this.createProviderSecret(config);
        } else {
          await this.createProviderSecret(config);
        }
        createdSecrets.add(providerName);
      }
    }

    // Create single backend with groups
    await this.createBackendWithGroups();

    // Create HTTPRoute for the groups backend
    await this.createHTTPRouteForGroups();
  }

  /**
   * Deploy providers using single provider mode (backward compatible)
   */
  async deploySingleProviders() {
    // Validate environment variables (skip in dry-run; placeholders will be used)
    if (!this.dryRun) {
      const missingEnvVars = [];
      for (const provider of this.normalizedProviders) {
        const providerName = provider.providerName || provider.name;
        const requiredVars = this.getRequiredEnvVars(provider);
        for (const envVar of requiredVars) {
          if (!process.env[envVar]) {
            missingEnvVars.push({ provider: providerName, envVar });
          }
        }
      }

      if (missingEnvVars.length > 0) {
        const errorMessages = missingEnvVars.map(
          ({ provider, envVar }) => `  - ${provider}: ${envVar} not set`
        );
        throw new Error(
          `Missing required environment variables for providers:\n${errorMessages.join('\n')}\n\n` +
            `Please set the required environment variables before deploying.`
        );
      }
    }

    // Deploy each provider: secret (when auth required), backend; then one or N HTTPRoutes
    for (const provider of this.normalizedProviders) {
      this.log(`Configuring provider: ${provider.name}`, 'info');
      if (this.getRequiredEnvVars(provider).length > 0) {
        if (provider.providerName === 'bedrock' && provider.authMode === 'credentials') {
          await this.createBedrockSecret();
        } else if (provider.providerName === 'bedrock') {
          await this.createProviderSecret(provider);
        } else {
          await this.createProviderSecret(provider);
        }
      }
      await this.createBackend(provider);
      if (!this.singleRoute) {
        await this.createHTTPRoute(provider);
      }
      this.log(
        `Provider ${provider.name} configured${this.singleRoute ? '' : ` at ${provider.pathPrefix}`}`,
        'info'
      );
    }
    if (this.singleRoute && this.normalizedProviders.length > 0) {
      if (this.bodyRouting) {
        await this.createBodyRoutingPolicy();
        if (this.bodyRoutingFallback) {
          await this.createFallbackGroupsBackend();
        }
        await this.createBodyRoutingHTTPRoute();
      } else if (this.queryParamRouting) {
        await this.createQueryParamRoutingHTTPRoute();
      } else {
        await this.createSingleRouteWithBackendRefs();
      }
    }
  }

  /**
   * Create secret for a provider (non-Bedrock)
   */
  async createProviderSecret(provider) {
    const providerName = provider.providerName || provider.name;
    const secretName = providerName === 'gemini' ? 'google-secret' : `${providerName}-secret`;
    const secretKey = 'Authorization';

    if (this.dryRun) {
      const envVarName = this.getEnvVarName(providerName);
      const placeholder = `<set ${envVarName}>`;
      const secret = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: secretName,
          namespace: this.namespace,
          labels: {
            'app.kubernetes.io/managed-by': 'agentgateway-demo',
            'agentgateway.dev/feature': this.name,
          },
        },
        stringData: { [secretKey]: placeholder },
      };
      await this.applyResource(secret);
      return;
    }

    const envVarName = this.getEnvVarName(providerName);
    const apiKey = process.env[envVarName];

    await KubernetesHelper.createSecretFromLiteral(
      this.namespace,
      secretName,
      secretKey,
      apiKey,
      this.spinner,
      { 'app.kubernetes.io/managed-by': 'agentgateway-demo', 'agentgateway.dev/feature': this.name }
    );
    this.log(`Created ${secretName}`, 'info');
  }

  /**
   * Create Bedrock secret with AWS credentials
   */
  async createBedrockSecret() {
    const secretData = this.dryRun
      ? { accessKey: '<set AWS_ACCESS_KEY_ID>', secretKey: '<set AWS_SECRET_ACCESS_KEY>' }
      : {
          accessKey: process.env.AWS_ACCESS_KEY_ID,
          secretKey: process.env.AWS_SECRET_ACCESS_KEY,
          ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN }),
        };

    const overrides = {
      metadata: {
        namespace: this.namespace,
      },
      stringData: secretData,
    };

    await this.applyYamlFile('bedrock-secret.yaml', overrides);
    if (!this.dryRun) {
      this.log(`Created Bedrock secret with AWS credentials`, 'info');
    }
  }

  async cleanup() {
    // Use label-based cleanup to catch all resources regardless of gateway-ref prefix
    const labels = {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
    };

    if (this.spinner?.isSpinning) {
      this.spinner.setText('Cleaning up provider HTTPRoutes...');
    }
    await this.deleteByLabel('HTTPRoute', labels);

    if (this.spinner?.isSpinning) {
      this.spinner.setText(`Cleaning up provider ${BACKEND_KIND[this.edition]}s...`);
    }
    await this.deleteByLabel(BACKEND_KIND[this.edition], labels);

    if (this.spinner?.isSpinning) {
      this.spinner.setText('Cleaning up provider Secrets...');
    }
    await this.deleteByLabel('Secret', labels);

    // Also clean up any body-routing policy created by this feature
    await this.deleteByLabel(POLICY_KIND[this.edition], labels);
  }

  /**
   * Build spec.policies.auth for AgentgatewayBackend.
   * Bedrock: authMode 'credentials' → auth.aws.secretRef; otherwise (default) → auth.secretRef (API key, like other providers).
   * Other providers: auth.secretRef only.
   * openai-compatible with no auth (no policies.auth.secretRef): return {} so no secret is referenced.
   *
   * When authMode=credentials, generated config is:
   *   policies:
   *     auth:
   *       aws:
   *         secretRef:
   *           name: bedrock-secret
   */
  static isAnthropicModel(model) {
    return model && (model.startsWith('anthropic/') || model.startsWith('claude-'));
  }

  static normalizeAnthropicModel(model) {
    if (!model) return model;
    if (model.startsWith('claude-')) return `anthropic/${model}`;
    return model;
  }

  static getVertexAnthropicAiPolicy(providerName, model) {
    if (providerName !== 'vertex-ai' || !ProvidersFeature.isAnthropicModel(model)) return null;

    const fullModel = ProvidersFeature.normalizeAnthropicModel(model);
    const bareName = fullModel.slice('anthropic/'.length);
    const atIdx = bareName.indexOf('@');
    const baseName = atIdx >= 0 ? bareName.substring(0, atIdx) : bareName;

    return {
      modelAliases: {
        [bareName]: fullModel,
        [`${baseName}@*`]: fullModel,
        [`${baseName}-*`]: fullModel,
      },
    };
  }

  static mergeAiPolicy(providerName, model, explicitAiPolicy) {
    const generated = ProvidersFeature.getVertexAnthropicAiPolicy(providerName, model);
    if (!generated && !explicitAiPolicy) return undefined;
    if (!generated) return explicitAiPolicy;
    if (!explicitAiPolicy) return generated;

    return {
      ...generated,
      ...explicitAiPolicy,
      routes: { ...generated.routes, ...(explicitAiPolicy.routes || {}) },
      modelAliases: { ...generated.modelAliases, ...(explicitAiPolicy.modelAliases || {}) },
    };
  }

  getBackendAuthPolicy(providerName, secretName, provider) {
    if (provider.authMode === 'none') {
      // No auth policy - client headers (e.g. X-Api-Key) pass through unchanged
      return {};
    }
    if (provider.authMode === 'passthrough') {
      return { passthrough: {}, secretRef: undefined };
    }
    if (providerName === 'bedrock' && provider.authMode === 'credentials') {
      return {
        aws: { secretRef: { name: secretName } },
        secretRef: undefined, // remove template's auth.secretRef so only auth.aws is present
      };
    }
    if (providerName === 'openai-compatible' && !provider.policies?.auth?.secretRef) {
      return {};
    }
    return { secretRef: { name: secretName } };
  }

  /**
   * Create AgentgatewayBackend resource for a provider
   */
  async createBackend(provider) {
    // Determine secret name based on providerName (actual provider type)
    const providerName = provider.providerName || provider.name;
    let secretName;
    if (providerName === 'bedrock') {
      secretName = 'bedrock-secret';
    } else if (providerName === 'gemini') {
      secretName = 'google-secret';
    } else if (providerName === 'vertex-ai') {
      secretName = 'vertex-ai-secret';
    } else {
      secretName = `${providerName}-secret`;
    }

    // When auth is empty, don't specify policies at all (deepMerge with undefined removes the key).
    const authPolicy = this.getBackendAuthPolicy(providerName, secretName, provider);
    const hasAuth = authPolicy && Object.keys(authPolicy).length > 0;
    // When modelMatch is RegularExpression the model is a routing pattern, not an actual model name
    const backendProvider =
      provider.modelMatch === 'RegularExpression' ? { ...provider, model: undefined } : provider;
    const llmConfig = this.getBackendLLMConfig(backendProvider);
    // host, port, path (when present) live under spec.ai.provider alongside openai/vertexai
    const aiSpec = { provider: llmConfig };
    const backendName = this.getResourceName(provider.name);
    const overrides = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: backendName,
        namespace: this.namespace,
        labels: {
          'agentgateway.dev/feature': this.name,
          'agentgateway.dev/provider': provider.name,
        },
      },
      spec: {
        ai: aiSpec,
        policies: (() => {
          const p = {};
          p.auth = hasAuth ? authPolicy : undefined;
          const aiPolicy = ProvidersFeature.mergeAiPolicy(
            providerName,
            provider.model,
            provider.policies?.ai
          );
          if (aiPolicy) p.ai = aiPolicy;
          return Object.values(p).some(v => v !== undefined) ? p : undefined;
        })(),
      },
    };

    await this.applyYamlFile('backend.yaml', overrides);
    this.log(`${BACKEND_KIND[this.edition]} created for ${backendName}`, 'info');
  }

  /**
   * Get LLM configuration for AgentgatewayBackend based on provider type
   */
  getBackendLLMConfig(provider) {
    const config = {};
    // Use providerName (actual provider type) for configuration lookup
    const providerName = provider.providerName || provider.name;

    switch (providerName) {
      case 'openai':
        config.openai = {
          model: provider.model,
        };
        break;

      case 'anthropic':
        config.anthropic = {
          model: provider.model,
        };
        break;

      case 'azure-openai':
        config.azureopenai = {
          endpoint: provider.endpoint || process.env.AZURE_OPENAI_ENDPOINT || '',
          deploymentName: provider.deploymentName || provider.model || '',
          apiVersion: provider.apiVersion || 'v1',
        };
        break;

      case 'bedrock':
        config.bedrock = {
          model: provider.model,
          region: provider.region || 'us-east-1',
        };

        // Add guardrail configuration if provided
        if (provider.guardrail) {
          config.bedrock.guardrail = {};

          if (provider.guardrail.guardrailId) {
            config.bedrock.guardrail.guardrailId = provider.guardrail.guardrailId;
          }

          if (provider.guardrail.guardrailVersion) {
            config.bedrock.guardrail.guardrailVersion = provider.guardrail.guardrailVersion;
          }
        }
        break;

      case 'gemini':
        config.gemini = {
          model: provider.model,
        };
        break;

      case 'vertex-ai': {
        const projectId = provider.projectId || process.env.GCP_PROJECT || '';
        if (!projectId || projectId.length < 1) {
          throw new Error(
            `Vertex AI provider "${provider.name}" requires projectId. ` +
              'Set spec.providers[].projectId in the use case config or set the GCP_PROJECT environment variable.'
          );
        }
        config.vertexai = {
          model: ProvidersFeature.normalizeAnthropicModel(provider.model),
          projectId,
          region: provider.location || process.env.GCP_LOCATION || 'us-central1',
        };

        // Add optional modelPath if specified
        if (provider.modelPath) {
          config.vertexai.modelPath = provider.modelPath;
        }
        break;
      }

      case 'openai-compatible': {
        // Defaults: localhost:11434, path /v1/chat/completions (host/port/path are siblings of openai in spec.ai).
        const defaults = ProvidersFeature.getOpenAICompatibleDefaults();
        const host = provider.host ?? defaults.host;
        const port = provider.port ?? defaults.port;
        const pathObj = provider.path ? { ...defaults.path, ...provider.path } : defaults.path;
        const pathStr =
          typeof pathObj === 'string' ? pathObj : (pathObj?.full ?? '/v1/chat/completions');
        config.openai = { model: provider.model };
        if (provider.authHeader) config.openai.authHeader = provider.authHeader;
        config.host = host;
        config.port = port;
        config.path = pathStr;
        break;
      }

      default:
        // Unknown provider: treat as openai-compatible (CRD allows only openai.model)
        config.openai = { model: provider.model };
        if (provider.authHeader) {
          config.openai.authHeader = provider.authHeader;
        }
    }

    return config;
  }

  /**
   * Create HTTPRoute resource for a provider
   */
  async createHTTPRoute(provider) {
    const gatewayRef = FeatureManager.getGatewayRef();
    const routeName = this.getResourceName(provider.name);
    const backendName = this.getResourceName(provider.name);
    const rule = {
      matches: [
        {
          path: {
            value: provider.pathPrefix,
          },
        },
      ],
      backendRefs: [
        {
          name: backendName,
          namespace: this.namespace,
          group: BACKEND_API_GROUP[this.edition],
          kind: BACKEND_KIND[this.edition],
        },
      ],
    };

    if (provider.upstreamRewrite) {
      // Redirect to a raw upstream host+path (e.g. a model-specific Bedrock invoke
      // endpoint) instead of the backend's own configured model/path.
      rule.filters = [
        {
          type: 'URLRewrite',
          urlRewrite: {
            hostname: provider.upstreamRewrite.hostname,
            path: {
              type: 'ReplaceFullPath',
              replaceFullPath: provider.upstreamRewrite.path,
            },
          },
        },
      ];
    } else if (provider.pathRewrite != null) {
      rule.filters = [
        {
          type: 'URLRewrite',
          urlRewrite: {
            path: {
              type: 'ReplacePrefixMatch',
              replacePrefixMatch: provider.pathRewrite,
            },
          },
        },
      ];
    }

    const overrides = {
      metadata: {
        name: routeName,
        namespace: this.namespace,
        labels: {
          'agentgateway.dev/feature': this.name,
          'agentgateway.dev/provider': provider.name,
        },
      },
      spec: {
        parentRefs: [
          {
            name: gatewayRef.name,
            namespace: gatewayRef.namespace,
          },
        ],
        ...(provider.hostname && { hostnames: [provider.hostname] }),
        rules: [rule],
      },
    };

    await this.applyYamlFile('httproute.yaml', overrides);
    const rewriteMsg = provider.pathRewrite != null ? ` (rewrite → ${provider.pathRewrite})` : '';
    this.log(
      `HTTPRoute created for ${provider.name} at ${provider.pathPrefix}${rewriteMsg}`,
      'info'
    );
  }

  /**
   * Create one HTTPRoute with multiple backendRefs (single endpoint, multiple backends).
   * Used when config.singleRoute is true.
   */
  async createSingleRouteWithBackendRefs() {
    const gatewayRef = FeatureManager.getGatewayRef();
    const backendRefs = this.normalizedProviders.map(provider => ({
      name: provider.name,
      namespace: this.namespace,
      group: BACKEND_API_GROUP[this.edition],
      kind: BACKEND_KIND[this.edition],
    }));
    const overrides = {
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: {
          'agentgateway.dev/feature': this.name,
          'agentgateway.dev/mode': 'single-route',
        },
      },
      spec: {
        parentRefs: [{ name: gatewayRef.name, namespace: gatewayRef.namespace }],
        rules: [
          {
            matches: [{ path: { value: this.pathPrefix } }],
            backendRefs,
          },
        ],
      },
    };
    await this.applyYamlFile('httproute.yaml', overrides);
    this.log(
      `HTTPRoute created (single route) at ${this.pathPrefix} with ${backendRefs.length} backendRefs`,
      'info'
    );
  }

  /**
   * Create a Policy (EnterpriseAgentgatewayPolicy/AgentgatewayPolicy, per edition) that
   * extracts the `model` field from the JSON request body and sets it as the
   * X-Gateway-Model-Name header in the PreRouting phase.
   * When failover is enabled (bodyRoutingFallback), a second header X-Gateway-Model-Status
   * is set to "specified" or "unspecified" so that the fallback rule only matches when no
   * model was provided (unknown models get a 404).
   *
   * Reference: https://blog.howardjohn.info/posts/bbr-agentgateway/
   * API: https://docs.solo.io/agentgateway/latest/reference/api/solo/#enterpriseagentgatewaypolicyspec
   */
  async createBodyRoutingPolicy() {
    const gatewayRef = FeatureManager.getGatewayRef();
    const setHeaders = [
      {
        name: 'X-Gateway-Model-Name',
        value: 'json(request.body).model',
      },
    ];
    if (this.bodyRoutingFallback) {
      setHeaders.push({
        name: 'X-Gateway-Model-Status',
        value: 'default(json(request.body).model, "") != "" ? "specified" : "unspecified"',
      });
    }
    const policy = {
      apiVersion: policyApiVersion(this.edition),
      kind: POLICY_KIND[this.edition],
      metadata: {
        name: this.policyName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        targetRefs: [
          {
            group: 'gateway.networking.k8s.io',
            kind: 'Gateway',
            name: gatewayRef.name,
          },
        ],
        traffic: {
          phase: 'PreRouting',
          transformation: {
            request: {
              set: setHeaders,
            },
          },
        },
      },
    };

    await this.applyResource(policy);
    this.log(
      `${POLICY_KIND[this.edition]} created for body-based routing (PreRouting: model → X-Gateway-Model-Name)`,
      'info'
    );
  }

  /**
   * Create an AgentgatewayBackend with priority groups for the fallback rule.
   * Each provider gets its own priority group, so failover follows the config ordering
   * (first provider = highest priority). Within each group a single provider is used.
   *
   * Reference: https://docs.solo.io/agentgateway/latest/llm/failover/#model-failover
   */
  async createFallbackGroupsBackend() {
    const groups = [];

    for (const provider of this.normalizedProviders) {
      const providerName = provider.providerName || provider.name;
      // Use fallbackModel (concrete name) for the failover group; fall back to model if not a regex
      const fallbackModel =
        provider.fallbackModel ||
        (provider.modelMatch === 'RegularExpression' ? undefined : provider.model);
      const backendProvider = { ...provider, model: fallbackModel };
      const llmConfig = this.getBackendLLMConfig(backendProvider);

      const namedProvider = {
        name: provider.name,
        ...llmConfig,
      };

      // Resolve secret name for auth (same logic as createBackend)
      let secretName;
      if (providerName === 'bedrock') {
        secretName = 'bedrock-secret';
      } else if (providerName === 'gemini') {
        secretName = 'google-secret';
      } else if (providerName === 'vertex-ai') {
        secretName = 'vertex-ai-secret';
      } else {
        secretName = `${providerName}-secret`;
      }

      const authPolicy = this.getBackendAuthPolicy(providerName, secretName, provider);
      const hasAuth = authPolicy && Object.keys(authPolicy).length > 0;
      const aiPolicy = ProvidersFeature.mergeAiPolicy(
        providerName,
        fallbackModel,
        provider.policies?.ai
      );
      const policies = {};
      if (hasAuth) policies.auth = authPolicy;
      if (aiPolicy) policies.ai = aiPolicy;
      if (Object.keys(policies).length > 0) {
        namedProvider.policies = policies;
      }

      // Each provider in its own group → failover ordering (first = highest priority)
      groups.push({ providers: [namedProvider] });
    }

    const overrides = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: this.fallbackBackendName,
        namespace: this.namespace,
        labels: {
          'agentgateway.dev/feature': this.name,
          'agentgateway.dev/mode': 'body-routing-fallback',
        },
      },
      spec: {
        ai: {
          groups,
          provider: undefined,
        },
        policies: undefined,
      },
    };

    await this.applyYamlFile('backend.yaml', overrides);
    this.log(
      `${BACKEND_KIND[this.edition]} created for fallback with ${groups.length} failover group(s)`,
      'info'
    );
  }

  /**
   * Create an HTTPRoute with per-model header matching rules.
   *
   * For each provider that has a model defined, a rule is created that matches on
   * the X-Gateway-Model-Name header (set by the BBR policy) and routes to that provider's backend.
   * When failover is enabled (bodyRoutingFallback), a final catch-all rule routes to the
   * failover groups backend for requests where no model was specified in the body.
   * Without failover, requests with no matching model simply get a 404.
   */
  async createBodyRoutingHTTPRoute() {
    const gatewayRef = FeatureManager.getGatewayRef();

    // Per-model rules: model header value → specific backend
    // Supports Exact (default) or RegularExpression matching via provider.modelMatch
    const modelRules = this.normalizedProviders
      .filter(p => p.model)
      .map(provider => {
        const headerMatch = {
          name: 'X-Gateway-Model-Name',
          value: provider.model,
        };
        // Only add type when non-default (Gateway API defaults to Exact)
        if (provider.modelMatch === 'RegularExpression') {
          headerMatch.type = 'RegularExpression';
        }
        const rule = {
          matches: [
            {
              path: { value: this.pathPrefix },
              headers: [headerMatch],
            },
          ],
          backendRefs: [
            {
              name: provider.name,
              namespace: this.namespace,
              group: BACKEND_API_GROUP[this.edition],
              kind: BACKEND_KIND[this.edition],
            },
          ],
        };
        if (provider.pathRewrite != null) {
          rule.filters = [
            {
              type: 'URLRewrite',
              urlRewrite: {
                path: {
                  type: 'ReplacePrefixMatch',
                  replacePrefixMatch: provider.pathRewrite,
                },
              },
            },
          ];
        }
        return rule;
      });

    const rules = [...modelRules];

    // Fallback rule: model not specified in body → failover groups backend
    // Unknown models (X-Gateway-Model-Status: "specified" but no model rule match) → 404
    if (this.bodyRoutingFallback) {
      rules.push({
        matches: [
          {
            path: { value: this.pathPrefix },
            headers: [
              {
                name: 'X-Gateway-Model-Status',
                value: 'unspecified',
              },
            ],
          },
        ],
        backendRefs: [
          {
            name: this.fallbackBackendName,
            namespace: this.namespace,
            group: BACKEND_API_GROUP[this.edition],
            kind: BACKEND_KIND[this.edition],
          },
        ],
      });
    }

    const overrides = {
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: {
          'agentgateway.dev/feature': this.name,
          'agentgateway.dev/mode': 'body-routing',
        },
      },
      spec: {
        parentRefs: [{ name: gatewayRef.name, namespace: gatewayRef.namespace }],
        rules,
      },
    };

    await this.applyYamlFile('httproute.yaml', overrides);
    const fallbackMsg = this.bodyRoutingFallback ? ' + failover fallback' : '';
    this.log(
      `HTTPRoute created (body routing) at ${this.pathPrefix} with ${modelRules.length} model rule(s)${fallbackMsg}`,
      'info'
    );
  }

  /**
   * Create a single HTTPRoute with per-model query parameter matching rules.
   *
   * For each provider that has a model defined, a rule is created that matches on
   * the shared pathPrefix + an Exact queryParams match (e.g. ?model=gpt-4o) and routes
   * to that provider's backend.  Mirrors the Gateway API HTTPQueryParamMatch spec.
   */
  async createQueryParamRoutingHTTPRoute() {
    const gatewayRef = FeatureManager.getGatewayRef();

    const rules = this.normalizedProviders
      .filter(p => p.model)
      .map(provider => {
        const rule = {
          matches: [
            {
              path: { value: this.pathPrefix },
              queryParams: [
                {
                  type: 'Exact',
                  name: this.queryParamName,
                  value: provider.model,
                },
              ],
            },
          ],
          backendRefs: [
            {
              name: provider.name,
              namespace: this.namespace,
              group: BACKEND_API_GROUP[this.edition],
              kind: BACKEND_KIND[this.edition],
            },
          ],
          timeouts: { request: '120s' },
        };
        if (provider.pathRewrite != null) {
          rule.filters = [
            {
              type: 'URLRewrite',
              urlRewrite: {
                path: {
                  type: 'ReplacePrefixMatch',
                  replacePrefixMatch: provider.pathRewrite,
                },
              },
            },
          ];
        }
        return rule;
      });

    const overrides = {
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: {
          'agentgateway.dev/feature': this.name,
          'agentgateway.dev/mode': 'query-param-routing',
        },
      },
      spec: {
        parentRefs: [{ name: gatewayRef.name, namespace: gatewayRef.namespace }],
        rules,
      },
    };

    await this.applyYamlFile('httproute.yaml', overrides);
    this.log(
      `HTTPRoute created (query param routing) at ${this.pathPrefix}?${this.queryParamName}=… with ${rules.length} rule(s)`,
      'info'
    );
  }

  /**
   * Get required environment variables for a provider.
   * @param {string|{ providerName?: string, name?: string, authMode?: string, policies?: { auth?: { secretRef?: object } } }} provider - Provider name (string) or config object. For Bedrock, authMode=credentials => AWS_ACCESS_KEY_ID/SECRET; otherwise => AWS_BEDROCK_API_KEY. For openai-compatible, no auth (no policies.auth.secretRef) => no env required.
   */
  getRequiredEnvVars(provider) {
    const name = typeof provider === 'string' ? provider : provider.providerName || provider.name;
    const authMode = typeof provider === 'object' ? provider.authMode : undefined;

    if (authMode === 'passthrough' || authMode === 'none') return [];

    if (name === 'bedrock') {
      if (authMode === 'credentials') {
        return ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
      }
      return ['AWS_BEDROCK_API_KEY'];
    }

    // openai-compatible: only require API key when auth is configured (secretRef)
    if (name === 'openai-compatible') {
      const hasAuth = typeof provider === 'object' && provider.policies?.auth?.secretRef;
      if (!hasAuth) {
        return [];
      }
      return ['OPENAI_COMPATIBLE_API_KEY'];
    }

    const envVarMap = {
      openai: ['OPENAI_API_KEY'],
      anthropic: ['ANTHROPIC_API_KEY'],
      'azure-openai': ['AZURE_OPENAI_API_KEY'],
      gemini: ['GEMINI_API_KEY'],
      'vertex-ai': ['GOOGLE_APPLICATION_CREDENTIALS'],
      'openai-compatible': ['OPENAI_COMPATIBLE_API_KEY'],
    };

    return envVarMap[name] || [`${String(name).toUpperCase().replace(/-/g, '_')}_API_KEY`];
  }

  /**
   * Get primary environment variable name for a provider (backward compatibility)
   */
  getEnvVarName(provider) {
    return this.getRequiredEnvVars(provider)[0];
  }

  /**
   * Create AgentgatewayBackend with groups configuration
   * Based on API: groups is array of PriorityGroup, each with providers array and optional policies
   */
  async createBackendWithGroups() {
    const groups = [];

    for (const groupConfig of this.groups) {
      const providers = [];

      for (const providerConfig of groupConfig.providers) {
        // Parse provider config
        const config =
          typeof providerConfig === 'string' ? { name: providerConfig } : providerConfig;

        // name is the free-form identifier used as SectionName in NamedLLMProvider
        const providerName = config.name;

        // providerName is the actual provider type (openai, vertex-ai, etc.) used for:
        // - Secret naming
        // - Provider configuration lookup
        // - Environment variable validation
        const actualProviderName = config.providerName || config.name;

        // Build provider object for getBackendLLMConfig (openai-compatible defaults applied there)
        const providerObj = {
          name: actualProviderName, // Use actual provider type for config
          ...config, // Include all other config (model, region, host, port, path, etc.)
        };

        // Get LLM provider configuration (returns object with provider type as key, e.g., { openai: {...} })
        const llmConfig = this.getBackendLLMConfig(providerObj);

        // Build NamedLLMProvider structure
        // The API expects: { name: "section-name", openai: {...}, policies: {...} }
        // name is used as SectionName for targeting with targetRefs[].sectionName
        // The provider type (openai, anthropic, etc.) is a key in the same object as the name
        // Per-provider policies allow overriding group-level policies
        const namedProvider = {
          name: providerName, // Free-form identifier used as SectionName
          ...llmConfig, // Spread the provider config (e.g., { openai: {...} })
        };

        const explicitPolicies = config.policies || {};
        const aiPolicy = ProvidersFeature.mergeAiPolicy(
          actualProviderName,
          config.model,
          explicitPolicies.ai
        );
        const merged = { ...explicitPolicies };
        if (aiPolicy) merged.ai = aiPolicy;
        if (merged.auth && !(merged.auth.secretRef || merged.auth.aws)) delete merged.auth;
        if (Object.keys(merged).length > 0) {
          namedProvider.policies = merged;
        }

        providers.push(namedProvider);
      }

      const group = {
        providers: providers,
      };

      // Add group-level policies if specified (applies to all providers in group unless overridden)
      // policies can include:
      // - auth: Authentication configuration (secretRef)
      // - ai: AI-specific policies (BackendAI) with promptEnrichment and promptGuard
      if (groupConfig.policies) {
        group.policies = groupConfig.policies;
      }

      groups.push(group);
    }

    const overrides = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: 'providers-groups',
        namespace: this.namespace,
        labels: {
          'agentgateway.dev/feature': 'providers',
          'agentgateway.dev/mode': 'groups',
        },
      },
      spec: {
        ai: {
          groups: groups,
          provider: undefined, // Explicitly remove provider field when using groups
        },
        policies: undefined, // Remove top-level policies - policies are per-group or per-provider in groups mode
      },
    };

    await this.applyYamlFile('backend.yaml', overrides);
    this.log(`${BACKEND_KIND[this.edition]} created with groups configuration`, 'info');
  }

  /**
   * Create HTTPRoute for groups mode
   */
  async createHTTPRouteForGroups() {
    const gatewayRef = FeatureManager.getGatewayRef();
    const overrides = {
      metadata: {
        name: 'providers-groups',
        namespace: this.namespace,
        labels: {
          'agentgateway.dev/feature': 'providers',
          'agentgateway.dev/mode': 'groups',
        },
      },
      spec: {
        parentRefs: [
          {
            name: gatewayRef.name,
            namespace: gatewayRef.namespace,
          },
        ],
        rules: [
          {
            matches: [
              {
                path: {
                  value: this.pathPrefix,
                },
              },
            ],
            backendRefs: [
              {
                name: 'providers-groups',
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
    this.log(`HTTPRoute created for groups at ${this.pathPrefix}`, 'info');
  }
}

// Export a factory function for easy instantiation
export function createProvidersFeature(config) {
  return new ProvidersFeature('providers', config);
}

import { Feature } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';
import {
  EDITION_GATEWAY_NAME,
  BACKEND_API_GROUP,
  BACKEND_KIND,
  policyApiVersion,
  POLICY_KIND,
} from '../../src/lib/editions.js';
import { writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';

const DEFAULT_VERSION = '0.3.0';
const OCI_CHART = 'oci://ghcr.io/vllm-project/charts/semantic-router';
const SIM_IMAGE = 'ghcr.io/llm-d/llm-d-inference-sim:latest';
const SIM_PORT = 8000;

/**
 * Semantic Router Feature
 *
 * Deploys the upstream vllm-project/semantic-router (vSR) Helm chart and wires it
 * into agentgateway as an ExtProc processor, so the gateway picks a "cheap" or
 * "premium" model per request based on prompt content, before route selection
 * (PreRouting).
 *
 * Verified against the real, exact example shipped in the agentgateway OSS repo
 * (github.com/agentgateway/agentgateway/tree/v1.4.1/examples/llm-semantic-routing):
 * vSR installs from the published OCI chart into the same namespace as
 * agentgateway (avoiding a cross-namespace ReferenceGrant for the ExtProc
 * backendRef); the ExtProc policy targets the HTTPRoute, with
 * traffic.extProc.backendRef pointing at the vSR Service on port 50051 and
 * processingOptions.requestBodyMode: FullDuplexStreamed.
 *
 * The "selected" Backend has a fixed host/port (not an empty
 * `openai: {}` block) - the upstream example gets away with an empty provider
 * because every model name it exposes is served by the SAME real OpenAI
 * endpoint; agentgateway has no mechanism to route one backend to different
 * hosts by the request's `model` field (`spec.ai.groups[].providers[]` is a
 * load-balancing/failover pool selected by health/latency, not by name -
 * confirmed against both the Backend CRD schema and agentgateway's
 * own docs). So the demo backend is a single llm-d-inference-sim instance
 * started with `--model <cheapModel>` plus a `--lora-modules` entry naming
 * <premiumModel> as a LoRA over that base model - one real Service that
 * legitimately answers to both names, mirroring how a real multi-model vLLM
 * deployment would serve every model vSR can select from a single endpoint.
 *
 * IMPORTANT - unlike the "no GPU/HF token needed" framing this repo's plan
 * assumed, the upstream chart's OWN values.yaml documents that it downloads an
 * embedding/classification model from HuggingFace at startup by default (its
 * readiness probe allows up to 60 minutes for this on a slow connection - see
 * deploy/helm/semantic-router/values.yaml in the upstream repo). No GPU or
 * HF_TOKEN is required for the chart's default (ungated) model, but the first
 * install is genuinely slow, unlike every other feature in this repo. The
 * chart's persistence.storageClassName defaults to the literal string
 * "standard", which doesn't exist on most clusters (e.g. EKS ships gp2/gp3) -
 * this feature clears it so the PVC falls back to the cluster's own default
 * StorageClass instead of sitting Pending forever.
 *
 * Configuration:
 * {
 *   name: string,               // Resource name prefix (default: 'semantic-router')
 *   version: string,            // vSR OCI chart version (default: '0.3.0')
 *   cheapModel: string,         // Cheap-tier model name (default: 'cheap-model')
 *   premiumModel: string,       // Premium-tier model name (default: 'premium-model')
 *   routeName: string,          // HTTPRoute name (default: '<prefix>')
 * }
 * Works on both editions: deployAgentgatewayWiring() uses BACKEND_KIND[this.edition]/
 * POLICY_KIND[this.edition] (EnterpriseAgentgatewayBackend/Policy on enterprise,
 * AgentgatewayBackend/Policy on opensource) - both editions' Policy schema support
 * traffic.extProc, and the enterprise chart installs the OSS agentgateway.dev CRDs
 * too, but the edition-native kind is used by default either way.
 */
export class SemanticRouterFeature extends Feature {
  get prefix() {
    return this.config.name || 'semantic-router';
  }

  get version() {
    return this.config.version || DEFAULT_VERSION;
  }

  get cheapModel() {
    return this.config.cheapModel || 'cheap-model';
  }

  get premiumModel() {
    return this.config.premiumModel || 'premium-model';
  }

  get routeName() {
    return this.config.routeName || this.prefix;
  }

  get labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
    };
  }

  get modelsAppName() {
    return `${this.prefix}-models`;
  }

  get modelsHost() {
    return `${this.modelsAppName}.${this.namespace}.svc.cluster.local`;
  }

  async deploy() {
    this.log('Deploying simulated model backend (base model + LoRA tier)...', 'info');
    await this.deployModelsWorkload();

    if (this.dryRun) {
      const comment = [
        `# Helm install (published OCI chart):`,
        `#   helm upgrade --install ${this.prefix} ${OCI_CHART} --version ${this.version} \\`,
        `#     --namespace ${this.namespace} -f <values below>`,
        yaml.dump(this.buildValuesOverride(), { lineWidth: -1, indent: 2 }).trim(),
      ].join('\n');
      this._dryRunYaml.push(comment);
    } else {
      this.log(
        'Installing vLLM Semantic Router chart (may take up to ~20m - the chart downloads a classification model on first install)...',
        'info'
      );
      await this.installSemanticRouterChart();
    }

    this.log('Wiring agentgateway ExtProc to the semantic router...', 'info');
    await this.deployAgentgatewayWiring();

    this.log('Semantic router deployed', 'success');
  }

  async deployModelsWorkload() {
    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: this.modelsAppName,
        namespace: this.namespace,
        labels: { ...this.labels, app: this.modelsAppName },
      },
      spec: {
        selector: { app: this.modelsAppName },
        ports: [{ port: SIM_PORT, targetPort: SIM_PORT, name: 'http' }],
        type: 'ClusterIP',
      },
    };
    await this.applyResource(service);

    const loraModule = JSON.stringify({
      name: this.premiumModel,
      path: `/loras/${this.premiumModel}`,
      base_model_name: this.cheapModel,
    });

    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: this.modelsAppName,
        namespace: this.namespace,
        labels: { ...this.labels, app: this.modelsAppName },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: this.modelsAppName } },
        template: {
          metadata: { labels: { app: this.modelsAppName } },
          spec: {
            containers: [
              {
                name: 'vllm-sim',
                image: SIM_IMAGE,
                imagePullPolicy: 'IfNotPresent',
                args: [
                  '--model',
                  this.cheapModel,
                  '--port',
                  String(SIM_PORT),
                  '--lora-modules',
                  loraModule,
                ],
                ports: [{ containerPort: SIM_PORT, name: 'http' }],
              },
            ],
          },
        },
      },
    };
    await this.applyResource(deployment);
    this.log(
      `Simulated backend '${this.modelsAppName}' deployed (base: ${this.cheapModel}, LoRA: ${this.premiumModel})`,
      'info'
    );
  }

  buildValuesOverride() {
    const backendRef = model => ({
      name: model,
      base_url: `http://${this.modelsHost}:${SIM_PORT}/v1`,
      provider: 'openai',
      weight: 100,
    });

    return {
      // Without this, the chart's fullname helper concatenates release+chart name
      // (e.g. "semantic-routing-semantic-router") since our release name (this.prefix)
      // differs from the chart name ("semantic-router") - which would silently break
      // the ExtProc backendRef below, which assumes the Service is named this.prefix.
      fullnameOverride: this.prefix,
      // The chart hardcodes storageClassName: "standard"; clear it so the PVC falls
      // back to the cluster's own default StorageClass instead of sitting Pending.
      persistence: { storageClassName: '' },
      // The published 0.3.0 chart's values.yaml has ~17 duplicate top-level `image:`
      // keys (bundled example/preset blocks flattened into one file); YAML takes the
      // last one, which is an internal e2e-test preset (pullPolicy: Never, tag:
      // e2e-test) that can never pull. Force the real image explicitly, matching the
      // upstream agentgateway example's own `--set-string image.tag=latest` - there is
      // no version-pinned image tag published, only `latest` and commit-SHA tags.
      image: { pullPolicy: 'IfNotPresent', tag: 'latest' },
      config: {
        version: 'v0.3',
        providers: {
          defaults: { default_model: this.cheapModel },
          models: [
            {
              name: this.cheapModel,
              provider_model_id: this.cheapModel,
              api_format: 'openai',
              backend_refs: [backendRef(this.cheapModel)],
            },
            {
              name: this.premiumModel,
              provider_model_id: this.premiumModel,
              api_format: 'openai',
              backend_refs: [backendRef(this.premiumModel)],
            },
          ],
        },
        routing: {
          // Required: the router refuses to start if providers.defaults.default_model
          // (or any decision's modelRefs) doesn't resolve to a routing.modelCards entry.
          modelCards: [
            {
              name: this.cheapModel,
              description: 'Low-cost tier for routine requests.',
              capabilities: ['chat'],
              quality_score: 0.6,
            },
            {
              name: this.premiumModel,
              description: 'Higher-capability tier for complex requests.',
              capabilities: ['chat'],
              quality_score: 0.95,
            },
          ],
          signals: {
            // The chart's own default domain signals reference an invalid mmlu_category
            // ("urgent_request"); this feature doesn't use domain signals, so clear it
            // rather than inherit a config that fails the router's own startup validation.
            domains: [],
            keywords: [
              {
                name: 'complex_markers',
                operator: 'OR',
                case_sensitive: false,
                keywords: [
                  'distributed',
                  'concurrency',
                  'architecture',
                  'proof',
                  'formal verification',
                  'root cause',
                ],
              },
            ],
          },
          decisions: [
            {
              name: 'route_to_premium',
              priority: 200,
              rules: {
                operator: 'AND',
                conditions: [{ type: 'keyword', name: 'complex_markers' }],
              },
              modelRefs: [{ model: this.premiumModel }],
            },
            {
              name: 'route_to_cheap',
              priority: 100,
              rules: { operator: 'AND', conditions: [] },
              modelRefs: [{ model: this.cheapModel }],
            },
          ],
        },
        global: {
          router: {
            config_source: 'file',
            auto_model_name: 'auto',
            strategy: 'priority',
          },
        },
      },
    };
  }

  async installSemanticRouterChart() {
    const valuesFile = join(tmpdir(), `semantic-router-values-${Date.now()}.yaml`);
    await writeFile(
      valuesFile,
      yaml.dump(this.buildValuesOverride(), { lineWidth: -1, indent: 2 }),
      'utf8'
    );

    try {
      await KubernetesHelper.helm([
        'upgrade',
        '--install',
        this.prefix,
        OCI_CHART,
        '--version',
        this.version,
        '--namespace',
        this.namespace,
        '-f',
        valuesFile,
        '--timeout',
        '30m',
        '--wait',
      ]);
    } finally {
      await rm(valuesFile, { force: true });
    }
  }

  async deployAgentgatewayWiring() {
    const backend = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: `${this.prefix}-selected`,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        // vSR rewrites the request's `model` field before agentgateway forwards it;
        // this backend just needs to reach a host that answers to every model name
        // vSR can select (see deployModelsWorkload() - one sim instance, base model
        // + a LoRA tier), same as a real multi-model vLLM deployment would.
        ai: {
          provider: {
            openai: {},
            host: this.modelsHost,
            port: SIM_PORT,
            path: '/v1/chat/completions',
          },
        },
        policies: {
          auth: { passthrough: {} },
        },
      },
    };
    await this.applyResource(backend);

    const route = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        parentRefs: [{ name: this.gatewayName(), namespace: this.namespace }],
        rules: [
          {
            matches: [
              { path: { type: 'PathPrefix', value: '/v1/chat/completions' } },
              { path: { type: 'PathPrefix', value: '/v1/responses' } },
            ],
            backendRefs: [
              {
                group: BACKEND_API_GROUP[this.edition],
                kind: BACKEND_KIND[this.edition],
                name: `${this.prefix}-selected`,
              },
            ],
          },
        ],
      },
    };
    await this.applyResource(route);

    const policy = {
      apiVersion: policyApiVersion(this.edition),
      kind: POLICY_KIND[this.edition],
      metadata: {
        name: `${this.prefix}-extproc`,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        targetRefs: [
          { group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: this.routeName },
        ],
        traffic: {
          extProc: {
            backendRef: { name: this.prefix, namespace: this.namespace, port: 50051 },
            processingOptions: {
              requestHeaderMode: 'Send',
              requestBodyMode: 'FullDuplexStreamed',
              responseHeaderMode: 'Send',
              responseBodyMode: 'Buffered',
              requestTrailerMode: 'Send',
              responseTrailerMode: 'Send',
              allowModeOverride: true,
            },
          },
        },
      },
    };
    await this.applyResource(policy);
  }

  gatewayName() {
    // Deliberately not FeatureManager.getGatewayRef() - this route targets the plain
    // Gateway object by name, matching the verified upstream example exactly; override
    // via config.gatewayName if the usecase runs against a non-default Gateway.
    return this.config.gatewayName || EDITION_GATEWAY_NAME[this.edition];
  }

  async cleanup() {
    this.log('Cleaning up semantic-router feature...', 'info');
    await this.deleteResource(POLICY_KIND[this.edition], `${this.prefix}-extproc`, this.namespace);
    await this.deleteResource('HTTPRoute', this.routeName, this.namespace);
    await this.deleteResource(
      BACKEND_KIND[this.edition],
      `${this.prefix}-selected`,
      this.namespace
    );

    try {
      await KubernetesHelper.helm(['uninstall', this.prefix, '--namespace', this.namespace], {
        ignoreError: true,
      });
    } catch {
      // best-effort - the chart may not have been installed (e.g. cleanup after a dry-run-only session)
    }

    await this.deleteResource('Deployment', this.modelsAppName, this.namespace);
    await this.deleteResource('Service', this.modelsAppName, this.namespace);

    this.log('semantic-router feature cleaned up', 'success');
  }
}

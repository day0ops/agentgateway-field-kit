import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';
import { EDITION_GATEWAY_NAME } from '../../src/lib/editions.js';

function envToArray(env) {
  if (!env) return [];
  if (Array.isArray(env)) return env;
  return Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
}

function envHasKey(env, key) {
  if (!env) return false;
  if (Array.isArray(env)) return env.some(e => e.name === key);
  return key in env;
}

/**
 * Generic Agent Feature
 *
 * Deploys an agent as a long-running Deployment with ServiceAccount, Service, and
 * HTTPRoute (path prefix + rewrite to /). Use for any agent image that exposes
 * POST /run and GET /health.
 *
 * Configuration:
 * {
 *   agentName: string,           // Deployment/Service/SA name (default: from image or 'agent')
 *   image: string,               // Required. Agent container image
 *   imagePullPolicy: string,     // Default: 'IfNotPresent'
 *   pathPrefix: string,          // Default: '/agent'
 *   pathRewrite: string | null,  // Replace path prefix with this before forwarding (default: '/'); null = no rewrite
 *   routeName: string,           // HTTPRoute name (default: agentName)
 *   port: number,               // Container port (default: 8080)
 *   env: object | [{name, value}],  // Env vars (merged with llmBaseUrl/mcpUrl/model if set)
 *   llmBaseUrl: string,          // Optional; added to env as LLM_BASE_URL
 *   mcpUrl: string,              // Optional; added to env as MCP_URL
 *   model: string,               // Optional; added to env as MODEL
 *   resources: { requests: {}, limits: {} },
 *   readinessProbe: { httpGet: { path, port }, ... },
 *   livenessProbe: { ... },
 * }
 */
export class AgentFeature extends Feature {
  constructor(name, config) {
    super(name, config);

    const ns = this.namespace;
    const gatewayServiceName = EDITION_GATEWAY_NAME[this.edition];
    this.agentName = config.agentName || config.name || name || 'agent';
    this.image = config.image;
    this.imagePullPolicy = config.imagePullPolicy || 'IfNotPresent';
    this.pathPrefix = config.pathPrefix || '/agent';
    this.pathRewrite = config.pathRewrite !== undefined ? config.pathRewrite : '/';
    this.routeName = config.routeName || this.agentName;
    this.port = config.port ?? 8080;

    const baseEnv = [];
    const hasLlm = config.llmBaseUrl != null || envHasKey(config.env, 'LLM_BASE_URL');
    const hasMcp = config.mcpUrl != null || envHasKey(config.env, 'MCP_URL');
    if (config.llmBaseUrl != null) {
      baseEnv.push({ name: 'LLM_BASE_URL', value: config.llmBaseUrl });
    } else if (config.model && !hasLlm) {
      baseEnv.push({
        name: 'LLM_BASE_URL',
        value: `http://${gatewayServiceName}.${ns}.svc.cluster.local:8080/openai`,
      });
    }
    if (config.mcpUrl != null) {
      baseEnv.push({ name: 'MCP_URL', value: config.mcpUrl });
    } else if (config.model && !hasMcp) {
      baseEnv.push({
        name: 'MCP_URL',
        value: `http://${gatewayServiceName}.${ns}.svc.cluster.local:8080/mcp`,
      });
    }
    if (config.model != null) {
      baseEnv.push({ name: 'MODEL', value: config.model });
    }
    const configEnv = envToArray(config.env);
    const envKeys = new Set(configEnv.map(e => e.name));
    baseEnv.forEach(e => {
      if (!envKeys.has(e.name)) {
        configEnv.push(e);
        envKeys.add(e.name);
      }
    });
    this.env = configEnv;

    this.resources = config.resources ?? {
      requests: { memory: '256Mi', cpu: '100m' },
      limits: { memory: '512Mi', cpu: '500m' },
    };
    const healthPath = config.healthPath ?? '/health';
    this.readinessProbe = config.readinessProbe ?? {
      httpGet: { path: healthPath, port: this.port },
      initialDelaySeconds: 15,
      periodSeconds: 10,
    };
    this.livenessProbe = config.livenessProbe ?? {
      httpGet: { path: healthPath, port: this.port },
      initialDelaySeconds: 30,
      periodSeconds: 30,
    };
  }

  getFeaturePath() {
    return 'agent';
  }

  async deploy() {
    if (!this.image) {
      throw new Error('agent feature requires config.image');
    }
    this.log(`Deploying agent ${this.agentName}...`, 'info');

    await this.deployServiceAccount();
    await this.deployDeployment();
    await this.deployService();
    await this.deployHTTPRoute();

    if (!this.dryRun) {
      await this.waitForReady();
    }

    this.log(`Agent ${this.agentName} deployed`, 'success');
  }

  async deployServiceAccount() {
    await this.applyYamlFile('serviceaccount.yaml', {
      metadata: {
        name: this.agentName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
          app: this.agentName,
        },
      },
    });
  }

  async deployDeployment() {
    await this.applyYamlFile('deployment.yaml', {
      metadata: {
        name: this.agentName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
          app: this.agentName,
        },
      },
      spec: {
        selector: { matchLabels: { app: this.agentName } },
        template: {
          metadata: { labels: { app: this.agentName } },
          spec: {
            serviceAccountName: this.agentName,
            containers: [
              {
                name: 'agent',
                image: this.image,
                imagePullPolicy: this.imagePullPolicy,
                ports: [{ containerPort: this.port }],
                env: this.env.length ? this.env : undefined,
                resources: this.resources,
                readinessProbe: this.readinessProbe,
                livenessProbe: this.livenessProbe,
              },
            ],
          },
        },
      },
    });
    this.log(`Deployment '${this.agentName}' created`, 'info');
  }

  async deployService() {
    await this.applyYamlFile('service.yaml', {
      metadata: {
        name: this.agentName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
          app: this.agentName,
        },
      },
      spec: {
        selector: { app: this.agentName },
        ports: [{ port: this.port, targetPort: this.port }],
        type: 'ClusterIP',
      },
    });
  }

  async deployHTTPRoute() {
    const gatewayRef = FeatureManager.getGatewayRef();
    await this.applyYamlFile('httproute.yaml', {
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        parentRefs: [{ name: gatewayRef.name, namespace: gatewayRef.namespace || this.namespace }],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: this.pathPrefix } }],
            ...(this.pathRewrite != null && {
              filters: [
                {
                  type: 'URLRewrite',
                  urlRewrite: {
                    path: { type: 'ReplacePrefixMatch', replacePrefixMatch: this.pathRewrite },
                  },
                },
              ],
            }),
            backendRefs: [{ name: this.agentName, namespace: this.namespace, port: this.port }],
          },
        ],
      },
    });
    const rewriteMsg = this.pathRewrite != null ? ` (rewrite → ${this.pathRewrite})` : '';
    this.log(`HTTPRoute '${this.routeName}' at ${this.pathPrefix}${rewriteMsg}`, 'info');
  }

  async waitForReady() {
    this.log(`Waiting for ${this.agentName} to be ready...`, 'info');
    try {
      await KubernetesHelper.kubectl([
        'rollout',
        'status',
        `deployment/${this.agentName}`,
        '-n',
        this.namespace,
        '--timeout=120s',
      ]);
    } catch {
      this.log(`${this.agentName} rollout timed out (may still be pulling image)`, 'warn');
    }
  }

  async cleanup() {
    this.log(`Cleaning up agent ${this.agentName}...`, 'info');

    await this.deleteResource('HTTPRoute', this.routeName);
    await this.deleteResource('Deployment', this.agentName);
    await this.deleteResource('Service', this.agentName);
    await this.deleteResource('ServiceAccount', this.agentName);

    this.log(`Agent ${this.agentName} cleaned up`, 'success');
  }
}

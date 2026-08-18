import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_RATELIMIT_BACKEND = 'rate-limiter-enterprise-agentgateway';

/**
 * Quota Rate Limit Feature
 *
 * @deprecated Replaced by the native 'budget-limits' feature (EnterpriseAgentgatewayBudget CRD).
 * No custom ext-proc infrastructure required. See features/budget-limits/index.js.
 *
 * Deploys the rate limit ext-proc service that runs at PreRouting phase.
 * Requires quota-budget feature (provides PostgreSQL database).
 *
 * Configuration:
 * {
 *   image: string,              // Extproc image (default: GAR quota-ratelimit-extproc:0.1.0)
 *   rateLimitBackend: string,   // Rate limit backend (default: 'rate-limiter-enterprise-agentgateway')
 *   modelHeader: string,        // Header for model name (default: 'x-gw-llm-model')
 *   databaseUrl: string,        // Override DB URL (default: uses quota-budget postgres)
 * }
 */
export class QuotaRateLimitFeature extends Feature {
  // Enterprise-only quota/budget management, confirmed no reusable OSS primitive exists.
  static SUPPORTED_EDITIONS = ['enterprise'];
  static DEPRECATED = {
    replacedBy: 'budget-limits',
    reason:
      'Replaced by the native EnterpriseAgentgatewayBudget CRD - no custom ext-proc/Postgres required.',
  };

  get extprocServiceName() {
    return 'quota-ratelimit-extproc';
  }

  get rateLimitBackend() {
    return this.config.rateLimitBackend || DEFAULT_RATELIMIT_BACKEND;
  }

  async deploy() {
    await this.deployRateLimitExtproc();

    await this.applyYamlFile('ext-proc-policy.yaml');

    await this.applyYamlFile('ratelimit-token-config.yaml');
    await this.applyYamlFile('ratelimit-request-config.yaml');

    const providerRoutes = this.config.providerRoutes || [];
    for (const route of providerRoutes) {
      const routeName = typeof route === 'string' ? route : route.name;
      await this.applyYamlFile('ratelimit-policy.yaml', {
        metadata: {
          name: `quota-ratelimit-${routeName}`,
        },
        spec: {
          targetRefs: [
            {
              group: 'gateway.networking.k8s.io',
              kind: 'HTTPRoute',
              name: routeName,
            },
          ],
          traffic: {
            entRateLimit: {
              global: {
                domain: 'solo.io',
                backendRef: {
                  name: this.rateLimitBackend,
                  port: 8083,
                },
                rateLimitConfigRefs: [
                  { name: 'quota-management-token-ratelimit' },
                  { name: 'quota-management-request-ratelimit' },
                ],
              },
            },
          },
        },
      });
      this.log(`Deployed rate limit policy for route: ${routeName}`);
    }

    await this.deployPodMonitor();
  }

  async deployRateLimitExtproc() {
    const image =
      this.config.image ||
      'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/quota-ratelimit-extproc:0.1.0';

    const { promises: fs } = await import('fs');
    let deploymentYaml = await fs.readFile(join(__dirname, 'config', 'deployment.yaml'), 'utf8');
    deploymentYaml = deploymentYaml.replace(
      /image: quota-ratelimit-extproc:latest/g,
      `image: ${image}`
    );

    if (this.config.databaseUrl) {
      deploymentYaml = deploymentYaml.replace(
        /value: 'postgres:\/\/budget:budget@quota-management-postgres:5432\/budget_management\?sslmode=disable'/g,
        `value: '${this.config.databaseUrl}'`
      );
    }

    if (this.config.modelHeader) {
      const yaml = (await import('js-yaml')).default;
      const documents = yaml.loadAll(deploymentYaml).filter(Boolean);
      const deployment = documents.find(d => d?.kind === 'Deployment');
      if (deployment) {
        const container = deployment.spec.template.spec.containers[0];
        container.env = container.env || [];
        container.env.push({ name: 'MODEL_HEADER', value: this.config.modelHeader });
        deploymentYaml = documents
          .map(d => yaml.dump(d, { lineWidth: -1, noRefs: true }))
          .join('---\n');
      }
    }

    await KubernetesHelper.applyYaml(deploymentYaml);
    this.log('Deployed quota-ratelimit-extproc');
  }

  async deployPodMonitor() {
    try {
      const result = await KubernetesHelper.kubectl(
        ['get', 'crd', 'podmonitors.monitoring.coreos.com'],
        { ignoreError: true }
      );
      if (result.exitCode !== 0) {
        this.log('PodMonitor CRD not found, skipping', 'info');
        return;
      }
      await this.applyYamlFile('pod-monitor.yaml');
      this.log('PodMonitor deployed for quota-ratelimit metrics');
    } catch (error) {
      this.log(`Failed to deploy PodMonitor: ${error.message}`, 'warn');
    }
  }

  async cleanup() {
    this.log('Cleaning up quota-ratelimit resources...');

    await KubernetesHelper.kubectl(
      [
        'delete',
        'enterpriseagentgatewaypolicies',
        '-l',
        'agentgateway.dev/feature=quota-ratelimit',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    await KubernetesHelper.kubectl(
      [
        'delete',
        'ratelimitconfigs',
        '-l',
        'agentgateway.dev/feature=quota-ratelimit',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    await KubernetesHelper.kubectl(
      [
        'delete',
        'deployment',
        'quota-ratelimit-extproc',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );
    await KubernetesHelper.kubectl(
      [
        'delete',
        'service',
        'quota-ratelimit-extproc',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    await KubernetesHelper.kubectl(
      [
        'delete',
        'podmonitor',
        'quota-ratelimit-metrics',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    this.log('quota-ratelimit cleanup complete');
  }
}

FeatureManager.register('quota-ratelimit', QuotaRateLimitFeature);

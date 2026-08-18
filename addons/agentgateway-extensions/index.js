import { Feature } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';

/**
 * AgentgatewayExtensions Addon
 *
 * Deploys a central "extensions-only" gateway that hosts shared infrastructure
 * services (ext-auth, rate-limiter, extCache/Redis) for use by sidecar agent
 * gateways. No HTTPRoutes are attached — this gateway carries no traffic.
 *
 * This allows multiple sidecar agent gateways to reference the shared extension
 * services via EnterpriseAgentgatewayPolicy without each deploying their own.
 *
 * Configuration:
 * {
 *   extauth: boolean,       // Enable ext-auth service (default: true)
 *   ratelimiter: boolean,   // Enable rate-limiter service (default: true)
 *   extCache: boolean,      // Enable extCache/Redis service (default: true)
 * }
 */
export class AgentgatewayExtensionsFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.extauth = config.extauth !== false;
    this.ratelimiter = config.ratelimiter !== false;
    this.extCache = config.extCache !== false;
  }

  validate() {
    return true;
  }

  async deploy() {
    this.log('Deploying agentgateway extensions gateway...', 'info');

    await this.applyGatewayClass();
    await this.applyParams();
    await this.applyGateway();

    this.log('Agentgateway extensions gateway deployed', 'success');
  }

  async applyGatewayClass() {
    await this.applyResource({
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'GatewayClass',
      metadata: {
        name: 'agentgateway-extensions',
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        controllerName: 'solo.io/enterprise-agentgateway',
        parametersRef: {
          group: 'enterpriseagentgateway.solo.io',
          kind: 'EnterpriseAgentgatewayParameters',
          name: 'agentgateway-extensions-params',
          namespace: this.namespace,
        },
      },
    });
  }

  async applyParams() {
    const sharedExtensions = {};
    if (this.extauth) sharedExtensions.extauth = { enabled: true };
    if (this.ratelimiter) sharedExtensions.ratelimiter = { enabled: true };
    if (this.extCache) sharedExtensions.extCache = { enabled: true };

    await this.applyResource({
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayParameters',
      metadata: {
        name: 'agentgateway-extensions-params',
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: { sharedExtensions },
    });
  }

  async applyGateway() {
    await this.applyResource({
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'Gateway',
      metadata: {
        name: 'agentgateway-extensions',
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        gatewayClassName: 'agentgateway-extensions',
        listeners: [
          {
            name: 'http',
            port: 8080,
            protocol: 'HTTP',
            allowedRoutes: { namespaces: { from: 'All' } },
          },
        ],
      },
    });
  }

  async cleanup() {
    this.log('Cleaning up agentgateway extensions gateway...', 'info');

    await this.deleteResource('Gateway', 'agentgateway-extensions', this.namespace);
    await this.deleteResource(
      'EnterpriseAgentgatewayParameters',
      'agentgateway-extensions-params',
      this.namespace
    );

    try {
      await KubernetesHelper.kubectl([
        'delete',
        'gatewayclass',
        'agentgateway-extensions',
        '--ignore-not-found=true',
      ]);
    } catch {
      // ignore
    }

    this.log('Agentgateway extensions gateway cleaned up', 'success');
  }
}

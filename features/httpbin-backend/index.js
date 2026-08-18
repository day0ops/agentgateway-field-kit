import { Feature } from '../../src/lib/feature.js';

const DEFAULT_IMAGE = 'kennethreitz/httpbin';
const DEFAULT_PORT = 80;

/**
 * Httpbin Backend Feature
 *
 * Deploys a plain httpbin Deployment+Service - a generic HTTP echo backend for
 * usecases that need to prove header-level behavior (e.g. that a token exchange
 * actually swapped the Authorization header reaching the upstream) rather than
 * exercise MCP tool semantics. Promoted from the inline deployEchoBackend()
 * pattern in features/multi-org-jwt-auth/index.js into a reusable feature.
 *
 * Configuration:
 * {
 *   name: string,   // Resource name prefix (default: 'httpbin-backend')
 *   image: string,  // Container image (default: 'kennethreitz/httpbin')
 *   port: number,   // Container/service port (default: 80)
 * }
 */
export class HttpbinBackendFeature extends Feature {
  get prefix() {
    return this.config.name || 'httpbin-backend';
  }

  get image() {
    return this.config.image || DEFAULT_IMAGE;
  }

  get port() {
    return this.config.port || DEFAULT_PORT;
  }

  get labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
    };
  }

  get serviceHost() {
    return `${this.prefix}.${this.namespace}.svc.cluster.local`;
  }

  async deploy() {
    this.log(`Deploying httpbin backend '${this.prefix}'...`, 'info');

    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: this.prefix,
        namespace: this.namespace,
        labels: { ...this.labels, app: this.prefix },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: this.prefix } },
        template: {
          metadata: { labels: { app: this.prefix, ...this.labels } },
          spec: {
            containers: [
              {
                name: 'httpbin',
                image: this.image,
                ports: [{ containerPort: this.port }],
                resources: {
                  requests: { cpu: '50m', memory: '64Mi' },
                  limits: { cpu: '200m', memory: '128Mi' },
                },
              },
            ],
          },
        },
      },
    };
    await this.applyResource(deployment);

    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: this.prefix,
        namespace: this.namespace,
        // app here (not just spec.selector) so other features in the same usecase can
        // discover this Service dynamically via mcp-enterprise/mcp-server's matchLabels,
        // the same way mcp-server's own Service carries its app label.
        labels: { ...this.labels, app: this.prefix },
      },
      spec: {
        selector: { app: this.prefix },
        ports: [{ port: this.port, targetPort: this.port }],
      },
    };
    await this.applyResource(service);

    this.log(`httpbin backend '${this.prefix}' deployed`, 'success');
  }

  async cleanup() {
    this.log(`Cleaning up httpbin backend '${this.prefix}'...`, 'info');
    await this.deleteResource('Deployment', this.prefix, this.namespace);
    await this.deleteResource('Service', this.prefix, this.namespace);
    this.log(`httpbin backend '${this.prefix}' cleaned up`, 'success');
  }
}

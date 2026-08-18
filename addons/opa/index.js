import { Feature } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';

const DEFAULT_OPA_IMAGE =
  'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/opa-ext-authz:latest';
const HTTP_PORT = 8181;
const GRPC_PORT = 9191;

/**
 * OPA Feature (manifest-based, no Helm)
 *
 * Deploys the custom OPA image (github.com/day0ops/opa-ext-authz) - OPA's
 * official envoy_ext_authz_grpc-enabled build with Rego authorization
 * policies and their static relationship data baked in at image build time.
 * Unlike addons/openfga, no bootstrap API step is needed here: OPA has
 * nothing to seed at deploy time.
 *
 * Reference: https://www.openpolicyagent.org/docs/envoy-primer/
 */
export class OpaFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.opaImage = config.image || DEFAULT_OPA_IMAGE;
  }

  getFeaturePath() {
    return 'opa';
  }

  validate() {
    return true;
  }

  async deploy() {
    this.log('Installing OPA...', 'info');
    await KubernetesHelper.ensureNamespace(this.namespace, this.spinner);
    await this.deployOpa();
    await this.waitForOpa();
    this.log('OPA installed successfully', 'success');
  }

  async deployOpa() {
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'opa',
        namespace: this.namespace,
        labels: { app: 'opa' },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'opa' } },
        template: {
          metadata: { labels: { app: 'opa' } },
          spec: {
            containers: [
              {
                name: 'opa',
                image: this.opaImage,
                ports: [
                  { name: 'http', containerPort: HTTP_PORT },
                  { name: 'grpc', containerPort: GRPC_PORT },
                ],
                readinessProbe: {
                  httpGet: { path: '/health', port: HTTP_PORT },
                  initialDelaySeconds: 5,
                  periodSeconds: 5,
                },
                livenessProbe: {
                  httpGet: { path: '/health', port: HTTP_PORT },
                  initialDelaySeconds: 10,
                  periodSeconds: 15,
                },
                resources: {
                  limits: { memory: '256Mi', cpu: '0.5' },
                  requests: { memory: '128Mi', cpu: '0.1' },
                },
              },
            ],
          },
        },
      },
    };

    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'opa',
        namespace: this.namespace,
        labels: { app: 'opa' },
      },
      spec: {
        selector: { app: 'opa' },
        ports: [
          { name: 'http', port: HTTP_PORT, targetPort: HTTP_PORT },
          { name: 'grpc', port: GRPC_PORT, targetPort: GRPC_PORT },
        ],
      },
    };

    await this.applyResource(deployment);
    await this.applyResource(service);
  }

  async waitForOpa() {
    this.log('Waiting for OPA to be ready...', 'info');
    try {
      await KubernetesHelper.cleanupAndWaitForDeployment(this.namespace, 'opa', 'app=opa', 120);
    } catch (error) {
      this.log(`OPA may not be fully ready: ${error.message}`, 'warn');
    }
  }

  async cleanup() {
    this.log('Cleaning up OPA...', 'info');
    await this.deleteResource('deployment', 'opa');
    await this.deleteResource('service', 'opa');
    this.log('OPA cleaned up', 'success');
  }
}

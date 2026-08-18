import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { BACKEND_API_GROUP, BACKEND_KIND } from '../../src/lib/editions.js';

/**
 * Mock Provider Feature
 *
 * Deploys a fake OpenAI-compatible chat-completions server (the vLLM community's
 * llm-d-inference-sim) and wires it up as a backend, so demos that need a
 * controllable backend (timeouts, retries, load testing) don't have to spend real
 * provider API calls or credentials. Emits EnterpriseAgentgatewayBackend on
 * enterprise and AgentgatewayBackend on opensource - both kinds support
 * ai.provider.openai and policies.auth.passthrough per the CRD schema. The
 * opensource path is schema-verified but not runtime-tested against an actual
 * opensource-edition cluster in this repo - confirm before relying on it.
 *
 * Reference: https://github.com/llm-d/llm-d-inference-sim
 *
 * Configuration:
 * {
 *   name: string,          // Deployment/Service/app name (default: 'mock-openai')
 *   model: string,         // Model name the sim answers to (default: 'mock-gpt-4o')
 *   image: string,         // Container image (default: ghcr.io/llm-d/llm-d-inference-sim:latest)
 *   port: number,          // Container/service port (default: 8000)
 *   replicas: number,      // Deployment replica count (default: 1)
 *   backendName: string,   // Backend resource name (default: '<name>-backend')
 *   routeName: string,     // HTTPRoute name (default: '<name>')
 *   pathPrefix: string,    // Route path prefix (default: '/mock-openai')
 * }
 */
export class MockProviderFeature extends Feature {
  constructor(name, config) {
    super(name, config);

    this.appName = config.name || 'mock-openai';
    this.model = config.model || 'mock-gpt-4o';
    this.image = config.image || 'ghcr.io/llm-d/llm-d-inference-sim:latest';
    this.port = config.port || 8000;
    this.replicas = config.replicas ?? 1;

    this.backendName = config.backendName || `${this.appName}-backend`;
    this.routeName = config.routeName || this.appName;
    this.pathPrefix = config.pathPrefix || '/mock-openai';
  }

  validate() {
    if (!this.model) {
      throw new Error('mock-provider requires a model in config');
    }
    return true;
  }

  get labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
    };
  }

  get serviceHost() {
    return `${this.appName}.${this.namespace}.svc.cluster.local`;
  }

  async deploy() {
    await this.deployWorkload();
    await this.deployBackend();
    await this.deployHTTPRoute();
  }

  async deployWorkload() {
    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: this.appName,
        namespace: this.namespace,
        labels: { ...this.labels, app: this.appName },
      },
      spec: {
        selector: { app: this.appName },
        ports: [{ port: this.port, targetPort: this.port, name: 'http' }],
        type: 'ClusterIP',
      },
    };
    await this.applyResource(service);

    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: this.appName,
        namespace: this.namespace,
        labels: { ...this.labels, app: this.appName },
      },
      spec: {
        replicas: this.replicas,
        selector: { matchLabels: { app: this.appName } },
        template: {
          metadata: { labels: { app: this.appName } },
          spec: {
            containers: [
              {
                name: 'vllm-sim',
                image: this.image,
                imagePullPolicy: 'IfNotPresent',
                args: ['--model', this.model, '--port', String(this.port)],
                ports: [{ containerPort: this.port, name: 'http' }],
              },
            ],
          },
        },
      },
    };
    await this.applyResource(deployment);
    this.log(`Mock OpenAI server '${this.appName}' deployed (model: ${this.model})`, 'info');
  }

  async deployBackend() {
    const backend = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: this.backendName,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        ai: {
          provider: {
            openai: { model: this.model },
            host: this.serviceHost,
            port: this.port,
            path: '/v1/chat/completions',
          },
        },
        policies: {
          auth: { passthrough: {} },
        },
      },
    };
    await this.applyResource(backend);
    this.log(`${BACKEND_KIND[this.edition]} '${this.backendName}' created`, 'info');
  }

  async deployHTTPRoute() {
    const gatewayRef = FeatureManager.getGatewayRef();

    const route = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: this.labels,
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
                path: { type: 'PathPrefix', value: this.pathPrefix },
              },
            ],
            backendRefs: [
              {
                name: this.backendName,
                group: BACKEND_API_GROUP[this.edition],
                kind: BACKEND_KIND[this.edition],
              },
            ],
            timeouts: { request: '120s' },
          },
        ],
      },
    };

    await this.applyResource(route);
    this.log(`HTTPRoute '${this.routeName}' created at ${this.pathPrefix}`, 'info');
  }

  async cleanup() {
    this.log('Cleaning up mock-provider feature...', 'info');
    await this.deleteResource('HTTPRoute', this.routeName);
    await this.deleteResource(BACKEND_KIND[this.edition], this.backendName);
    await this.deleteResource('Service', this.appName);
    await this.deleteResource('Deployment', this.appName);
    this.log('mock-provider feature cleaned up', 'info');
  }
}

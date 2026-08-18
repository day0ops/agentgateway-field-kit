import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';
import {
  policyApiVersion,
  PARAMETERS_KIND,
  POLICY_API_GROUP,
  CONTROLLER_NAME,
} from '../../src/lib/editions.js';

const GATEWAY_CLASS_NAME = 'sidecar-agentgateway';

/**
 * SidecarAgent Feature
 *
 * Deploys a dedicated agentgateway pod with the agent running as a sidecar
 * container alongside the agentgateway proxy. The agent communicates with
 * agentgateway via localhost:8080.
 *
 * Resources deployed:
 *   - GatewayClass sidecar-agentgateway (shared; created idempotently)
 *   - AgentgatewayParameters/EnterpriseAgentgatewayParameters <agentName>-params
 *     (per-Gateway sidecar injection; kind depends on edition)
 *   - Gateway <agentName> (references GatewayClass + Parameters via infrastructure.parametersRef)
 *   - Service <agentName>-agent (exposes agent port on the gateway-managed pods)
 *
 * Must be listed before the 'providers' feature in the use case, as it sets
 * the gateway ref that providers uses to target the correct Gateway.
 *
 * Configuration:
 * {
 *   agentName: string,        // K8s resource name prefix (required)
 *   agentImage: string,       // Container image (default: GAR sidecar-agent:0.1.1)
 *   agentPort: number,        // Port the agent listens on (default: 8081)
 *   model: string,            // LLM model name (default: gpt-4o-mini)
 *   llmPath: string,          // Path on agentgateway for LLM traffic (default: /openai)
 * }
 */
export class SidecarAgentFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.agentName = config.agentName;
    this.agentImage =
      config.agentImage ||
      'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/sidecar-agent:0.1.1';
    this.agentPort = config.agentPort || 8081;
    this.model = config.model || 'gpt-4o-mini';
    this.llmPath = config.llmPath || '/openai';
  }

  validate() {
    if (!this.agentName) throw new Error('sidecar-agent: agentName is required');
    return true;
  }

  async deploy() {
    this.validate();
    this.log(`Deploying sidecar agent '${this.agentName}'...`, 'info');

    await this.ensureGatewayClass();
    await this.applyParams();
    await this.applyGateway();
    await this.applyService();

    FeatureManager.setGatewayRef({
      name: this.agentName,
      namespace: this.namespace,
    });

    this.log(`Sidecar agent '${this.agentName}' deployed`, 'success');
  }

  async ensureGatewayClass() {
    await this.applyResource({
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'GatewayClass',
      metadata: {
        name: GATEWAY_CLASS_NAME,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        controllerName: CONTROLLER_NAME[this.edition],
      },
    });
  }

  async applyParams() {
    const llmBaseUrl = `http://localhost:8080${this.llmPath}`;

    await this.applyResource({
      apiVersion: policyApiVersion(this.edition),
      kind: PARAMETERS_KIND[this.edition],
      metadata: {
        name: `${this.agentName}-params`,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        service: {
          spec: {
            type: 'ClusterIP',
          },
        },
        deployment: {
          spec: {
            template: {
              spec: {
                containers: [
                  {
                    name: this.agentName,
                    image: this.agentImage,
                    ports: [{ containerPort: this.agentPort }],
                    env: [
                      { name: 'LLM_BASE_URL', value: llmBaseUrl },
                      { name: 'MODEL', value: this.model },
                      { name: 'AGENT_NAME', value: this.agentName },
                      { name: 'PORT', value: String(this.agentPort) },
                    ],
                    readinessProbe: {
                      httpGet: { path: '/health', port: this.agentPort },
                      initialDelaySeconds: 10,
                      periodSeconds: 10,
                    },
                    livenessProbe: {
                      httpGet: { path: '/health', port: this.agentPort },
                      initialDelaySeconds: 20,
                      periodSeconds: 30,
                    },
                  },
                ],
              },
            },
          },
        },
      },
    });
  }

  async applyGateway() {
    await this.applyResource({
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'Gateway',
      metadata: {
        name: this.agentName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        gatewayClassName: GATEWAY_CLASS_NAME,
        infrastructure: {
          parametersRef: {
            name: `${this.agentName}-params`,
            group: POLICY_API_GROUP[this.edition],
            kind: PARAMETERS_KIND[this.edition],
          },
        },
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

  async applyService() {
    await this.applyResource({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: `${this.agentName}-agent`,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        // Selects pods managed by the Gateway controller for this Gateway.
        // The agentgateway controller labels Gateway-managed pods with app.kubernetes.io/name.
        selector: { 'app.kubernetes.io/name': this.agentName },
        ports: [
          {
            name: 'agent',
            port: this.agentPort,
            targetPort: this.agentPort,
            protocol: 'TCP',
          },
        ],
      },
    });
  }

  async cleanup() {
    this.log(`Cleaning up sidecar agent '${this.agentName}'...`, 'info');

    await this.deleteResource('Service', `${this.agentName}-agent`, this.namespace);
    await this.deleteResource('Gateway', this.agentName, this.namespace);
    await this.deleteResource(
      PARAMETERS_KIND[this.edition],
      `${this.agentName}-params`,
      this.namespace
    );

    // GatewayClass is shared — not deleted on per-agent cleanup.
    // Remove manually if no sidecar agents remain.

    this.log(`Sidecar agent '${this.agentName}' cleaned up`, 'success');
  }
}

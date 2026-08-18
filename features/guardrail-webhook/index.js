import { Feature } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';
import { policyApiVersion, POLICY_KIND } from '../../src/lib/editions.js';

/**
 * Guardrail Webhook Feature
 *
 * Deploys an Opik-powered guardrail webhook server and wires it into the
 * promptGuard API's webhook variant (backend.ai.promptGuard.request/response[].webhook)
 * as pre-hook (request) and/or post-hook (response) guardrails. This field shape is
 * identical on both editions, only the CRD group/kind differs.
 *
 * Server source: extras/guardrail-webhook/server/
 *
 * Flow:
 *   1. Pre-hook  — webhook scans user prompt (PII, toxicity, banned words, Opik Sentiment/Tone)
 *   2. LLM call  — request is forwarded to the backend provider
 *   3. Post-hook — webhook scans LLM response (PII masking, sentiment safety)
 *
 * The webhook server implements the Solo.io Guardrail Webhook API contract:
 *   POST /request  -> PassAction | MaskAction | RejectAction
 *   POST /response -> PassAction | MaskAction
 *
 * All guardrail decisions are traced to Opik when OPIK_API_KEY is provided.
 *
 * Configuration:
 * {
 *   webhook: {
 *     image: string,            // Container image (default: GAR guardrail-webhook:0.1.1)
 *     port: number,             // Container/service port (default: 8000)
 *     serviceName: string,      // Kubernetes service name (default: opik-guardrail-webhook)
 *   },
 *   opik: {
 *     projectName: string,      // Opik project (default: agentgateway-guardrails)
 *     workspace: string,        // Opik workspace (optional)
 *     urlOverride: string       // Self-hosted Opik URL (optional)
 *   },
 *   request: boolean,           // Enable pre-hook webhook guard (default: true)
 *   response: boolean,          // Enable post-hook webhook guard (default: true)
 *   targetRefs: [...]           // Auto-injected from providers; or set manually
 * }
 */
export class GuardrailWebhookFeature extends Feature {
  validate() {
    return true;
  }

  get webhookConfig() {
    const defaults = {
      image:
        'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/guardrail-webhook:0.1.1',
      port: 8000,
      serviceName: 'opik-guardrail-webhook',
    };
    const merged = { ...defaults, ...(this.config.webhook || {}) };
    return merged;
  }

  get opikConfig() {
    return this.config.opik || {};
  }

  async deploy() {
    const {
      request: enableRequest = true,
      response: enableResponse = true,
      targetRefs = null,
    } = this.config;

    const { serviceName, port } = this.webhookConfig;

    await this.deployWebhookServer();

    const policyOverrides = {
      apiVersion: policyApiVersion(this.edition),
      kind: POLICY_KIND[this.edition],
      spec: {
        backend: {
          ai: {
            promptGuard: {},
          },
        },
      },
    };

    if (targetRefs) {
      policyOverrides.spec.targetRefs = targetRefs;
    }

    const webhookRef = {
      webhook: {
        backendRef: {
          name: serviceName,
          namespace: this.namespace,
          kind: 'Service',
          port,
        },
        forwardHeaderMatches: [{ name: 'traceparent', type: 'RegularExpression', value: '.*' }],
      },
    };

    if (enableRequest) {
      policyOverrides.spec.backend.ai.promptGuard.request = [{ ...webhookRef }];
    }

    if (enableResponse) {
      policyOverrides.spec.backend.ai.promptGuard.response = [{ ...webhookRef }];
    }

    await this.applyYamlFile('traffic-policy.yaml', policyOverrides);
  }

  async deployWebhookServer() {
    const { image, port, serviceName } = this.webhookConfig;
    const opik = this.opikConfig;

    await this.applyResource({
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: {
        name: 'opik-guardrail',
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
          account: 'opik-guardrail',
        },
      },
    });

    const env = [];

    if (opik.projectName) {
      env.push({ name: 'OPIK_PROJECT_NAME', value: opik.projectName });
    }
    if (opik.workspace) {
      env.push({ name: 'OPIK_WORKSPACE', value: opik.workspace });
    }
    if (opik.urlOverride) {
      env.push({ name: 'OPIK_URL_OVERRIDE', value: opik.urlOverride });
    }

    await this.ensureOpikSecret();
    env.push({
      name: 'OPIK_API_KEY',
      valueFrom: {
        secretKeyRef: {
          name: 'opik-secret',
          key: 'api-key',
        },
      },
    });

    await this.applyResource({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: serviceName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
          app: 'opik-guardrail',
        },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: serviceName } },
        template: {
          metadata: { labels: { app: serviceName } },
          spec: {
            serviceAccountName: 'opik-guardrail',
            containers: [
              {
                name: 'webhook',
                image,
                ports: [{ containerPort: port }],
                ...(env.length > 0 ? { env } : {}),
                resources: {
                  requests: { memory: '128Mi', cpu: '100m' },
                  limits: { memory: '256Mi', cpu: '200m' },
                },
                readinessProbe: {
                  httpGet: { path: '/docs', port },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: '/docs', port },
                  initialDelaySeconds: 10,
                  periodSeconds: 30,
                },
              },
            ],
          },
        },
      },
    });

    await this.applyResource({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: serviceName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
          app: 'opik-guardrail',
        },
      },
      spec: {
        selector: { app: serviceName },
        ports: [{ port, targetPort: port }],
        type: 'ClusterIP',
      },
    });

    this.log(`Guardrail webhook server deployed: ${serviceName}`, 'info');
  }

  async ensureOpikSecret() {
    const secretName = 'opik-secret';

    if (this.dryRun) {
      await this.applyResource({
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
        stringData: { 'api-key': '<set OPIK_API_KEY>' },
      });
      return;
    }

    const apiKey = process.env.OPIK_API_KEY || '';

    if (!apiKey) {
      throw new Error('OPIK_API_KEY environment variable is required for the guardrail webhook');
    }

    await KubernetesHelper.createSecretFromLiteral(
      this.namespace,
      secretName,
      'api-key',
      apiKey,
      this.spinner
    );
    this.log(`Created/updated ${secretName}`, 'info');
  }

  async cleanup() {
    const { serviceName } = this.webhookConfig;

    await this.deleteResource(POLICY_KIND[this.edition], 'guardrail-webhook');
    await this.deleteResource('Deployment', serviceName);
    await this.deleteResource('Service', serviceName);
    await this.deleteResource('ServiceAccount', 'opik-guardrail');
    await this.deleteResource('Secret', 'opik-secret');
  }
}

export function createGuardrailWebhookFeature(config) {
  return new GuardrailWebhookFeature('guardrail-webhook', config);
}

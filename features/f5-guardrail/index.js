import { Feature } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';
import { policyApiVersion, POLICY_KIND } from '../../src/lib/editions.js';

/**
 * F5 Guardrail Feature
 *
 * Deploys an F5 AI Guardrails guardrail webhook adapter and wires it into the
 * promptGuard API's webhook variant (backend.ai.promptGuard.request/response[].webhook)
 * as pre-hook (request) and/or post-hook (response) guardrails. Enterprise-only: no
 * OSS agentgateway.dev CRD equivalent exists for promptGuard.
 *
 * Server source: companion day0ops/f5-guardrail-webhook repo.
 *
 * Unlike guardrail-webhook's optional Opik project name, F5_AISEC_URL and CAI_PROJECT
 * are required environment variables (not optional config) - the F5 AI Guardrails backend
 * needs all three credentials (URL, project, token) to function at all, so deploy() fails
 * fast rather than deploying a webhook that can't actually reach F5.
 *
 * Configuration:
 * {
 *   webhook: {
 *     image: string,            // Container image (default: GAR f5-guardrail-webhook:0.1.0)
 *     port: number,             // Container/service port (default: 8000)
 *     serviceName: string,      // Kubernetes service name (default: f5-guardrail-webhook)
 *   },
 *   f5: {
 *     projectName: string,      // Override for CAI_PROJECT (optional; env var used otherwise)
 *   },
 *   request: boolean,           // Enable pre-hook webhook guard (default: true)
 *   response: boolean,          // Enable post-hook webhook guard (default: true)
 *   failureMode: string,        // 'FailClosed' (default, rejects traffic) or 'FailOpen'
 *                                  (allows traffic) when the webhook itself is unreachable
 *   targetRefs: [...]           // Auto-injected from providers; or set manually
 * }
 */
export class F5GuardrailFeature extends Feature {
  static SUPPORTED_EDITIONS = ['enterprise'];

  validate() {
    return true;
  }

  get webhookConfig() {
    const defaults = {
      image:
        'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/f5-guardrail-webhook:0.1.0',
      port: 8000,
      serviceName: 'f5-guardrail-webhook',
    };
    return { ...defaults, ...(this.config.webhook || {}) };
  }

  get f5Config() {
    return this.config.f5 || {};
  }

  async deploy() {
    const {
      request: enableRequest = true,
      response: enableResponse = true,
      targetRefs = null,
      failureMode = 'FailClosed',
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
        failureMode,
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

    // Validate required env vars before creating any Kubernetes resource, so a
    // misconfigured deploy fails fast instead of leaving a partial Secret behind.
    const f5AisecUrl = this.requireEnv('F5_AISEC_URL');
    const caiProject = this.f5Config.projectName || this.requireEnv('CAI_PROJECT');

    await this.applyResource({
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: {
        name: 'f5-guardrail',
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
          account: 'f5-guardrail',
        },
      },
    });

    await this.ensureF5Secret();

    const env = [
      { name: 'F5_AISEC_URL', value: f5AisecUrl },
      { name: 'CAI_PROJECT', value: caiProject },
      {
        name: 'F5_AISEC_TOKEN',
        valueFrom: {
          secretKeyRef: {
            name: 'f5-aisec-secret',
            key: 'token',
          },
        },
      },
    ];

    await this.applyResource({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: serviceName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
          app: 'f5-guardrail',
        },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: serviceName } },
        template: {
          metadata: { labels: { app: serviceName } },
          spec: {
            serviceAccountName: 'f5-guardrail',
            containers: [
              {
                name: 'webhook',
                image,
                ports: [{ containerPort: port }],
                env,
                resources: {
                  requests: { memory: '128Mi', cpu: '100m' },
                  limits: { memory: '256Mi', cpu: '200m' },
                },
                readinessProbe: {
                  httpGet: { path: '/healthz', port },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: '/healthz', port },
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
          app: 'f5-guardrail',
        },
      },
      spec: {
        selector: { app: serviceName },
        ports: [{ port, targetPort: port }],
        type: 'ClusterIP',
      },
    });

    this.log(`F5 guardrail webhook server deployed: ${serviceName}`, 'info');
  }

  /**
   * Reads a required env var, deferring the fail-fast check during dryRun so YAML
   * generation (and the opensource-edition rejection, checked before deploy() runs at
   * all) never depends on real F5 credentials being present.
   */
  requireEnv(name) {
    if (this.dryRun) {
      return `<set ${name}>`;
    }
    const value = process.env[name] || '';
    if (!value) {
      throw new Error(`${name} environment variable is required for the F5 guardrail`);
    }
    return value;
  }

  async ensureF5Secret() {
    const secretName = 'f5-aisec-secret';

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
        stringData: { token: '<set F5_AISEC_TOKEN>' },
      });
      return;
    }

    const token = process.env.F5_AISEC_TOKEN || '';

    if (!token) {
      throw new Error('F5_AISEC_TOKEN environment variable is required for the F5 guardrail');
    }

    await KubernetesHelper.createSecretFromLiteral(
      this.namespace,
      secretName,
      'token',
      token,
      this.spinner
    );
    this.log(`Created/updated ${secretName}`, 'info');
  }

  async cleanup() {
    const { serviceName } = this.webhookConfig;

    await this.deleteResource(POLICY_KIND[this.edition], 'f5-guardrail');
    await this.deleteResource('Deployment', serviceName);
    await this.deleteResource('Service', serviceName);
    await this.deleteResource('ServiceAccount', 'f5-guardrail');
    await this.deleteResource('Secret', 'f5-aisec-secret');
  }
}

export function createF5GuardrailFeature(config) {
  return new F5GuardrailFeature('f5-guardrail', config);
}

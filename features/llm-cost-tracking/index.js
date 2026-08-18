import { Feature } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';

/**
 * LLM Cost Tracking Feature
 *
 * Configures Prometheus scraping of agentgateway token usage metrics.
 * The metric `agentgateway_gen_ai_client_token_usage` is emitted automatically
 * by agentgateway — this feature deploys the ServiceMonitor so Prometheus
 * Operator picks it up.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/llm/cost-tracking/
 *
 * Key metric:
 *   agentgateway_gen_ai_client_token_usage{gen_ai_system, gen_ai_request_model, ...}
 *
 * PromQL example:
 *   sum by (gen_ai_system, gen_ai_request_model) (agentgateway_gen_ai_client_token_usage)
 *
 * Configuration:
 * {
 *   monitoringNamespace: string,  // Namespace where Prometheus Operator runs (default: 'monitoring')
 *   scrapeInterval: string,       // Prometheus scrape interval (default: '15s')
 * }
 */
export class LlmCostTrackingFeature extends Feature {
  // Enterprise-only quota/budget management, confirmed no reusable OSS primitive exists.
  static SUPPORTED_EDITIONS = ['enterprise'];

  constructor(name, config) {
    super(name, config);
    this.monitoringNamespace = config.monitoringNamespace || 'monitoring';
    this.scrapeInterval = config.scrapeInterval || '15s';
  }

  validate() {
    return true;
  }

  async deploy() {
    this.log('Configuring LLM cost tracking...', 'info');

    // Dry-run (YAML preview/runbook generation) has no live cluster to check against -
    // assume the CRD is present so the ServiceMonitor still shows up in the output.
    if (!this.dryRun) {
      const hasServiceMonitorCrd = await this._checkServiceMonitorCrd();
      if (!hasServiceMonitorCrd) {
        this.log(
          'servicemonitors.monitoring.coreos.com CRD not found — skipping ServiceMonitor. Deploy Prometheus Operator to enable.',
          'warn'
        );
        return;
      }
    }

    await this.applyYamlFile('service-monitor.yaml', {
      metadata: {
        name: 'agentgateway-llm-metrics',
        namespace: this.namespace,
        labels: { 'agentgateway.dev/feature': 'llm-cost-tracking' },
      },
      spec: {
        endpoints: [
          {
            port: 'http',
            path: '/metrics',
            interval: this.scrapeInterval,
          },
        ],
      },
    });

    this.log(
      'ServiceMonitor deployed. Key metric: agentgateway_gen_ai_client_token_usage',
      'success'
    );
    this.log(
      'PromQL: sum by (gen_ai_system, gen_ai_request_model) (agentgateway_gen_ai_client_token_usage)',
      'info'
    );
  }

  async _checkServiceMonitorCrd() {
    try {
      const result = await KubernetesHelper.kubectl(
        ['get', 'crd', 'servicemonitors.monitoring.coreos.com'],
        { ignoreError: true }
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async cleanup() {
    await this.deleteResource('ServiceMonitor', 'agentgateway-llm-metrics');
  }
}

export function createLlmCostTrackingFeature(config) {
  return new LlmCostTrackingFeature('llm-cost-tracking', config);
}

import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { policyApiVersion, POLICY_KIND } from '../../src/lib/editions.js';

/**
 * Metric Labels Feature
 *
 * Attaches custom CEL-derived labels to every Prometheus metric agentgateway exposes
 * (gen_ai_client_token_usage, gen_ai_client_cost, requests_total, etc.), via
 * spec.metrics.attributes.add. Lets identity (org/team/user) show up as a real metric
 * label instead of requiring a logs pipeline to break down spend by caller.
 *
 * Reference (OSS): controller/api/v1alpha1/agentgateway/agentgateway_policy_types.go,
 * MetricLabels/MetricAttributes types, in github.com/agentgateway/agentgateway.
 *
 * Configuration:
 * {
 *   labels: [                 // 1 to 16 entries, mirroring the CRD's own constraints
 *     { name: string, expression: string }  // expression is a CEL string, e.g. 'jwt.org_id'
 *   ],
 *   targetRefs: [              // Optional; defaults to the Gateway
 *     { group: string, kind: string, name: string }
 *   ],
 * }
 */
export class MetricLabelsFeature extends Feature {
  validate() {
    const { labels } = this.config;
    if (!labels || labels.length === 0) {
      throw new Error('metric-labels: at least one label is required');
    }
    if (labels.length > 16) {
      throw new Error('metric-labels: at most 16 labels are supported');
    }
    for (const label of labels) {
      if (!label.name || !label.expression) {
        throw new Error('metric-labels: each label requires a name and an expression');
      }
    }
    return true;
  }

  get targetRefs() {
    if (this.config.targetRefs) return this.config.targetRefs;
    const gatewayRef = FeatureManager.getGatewayRef();
    return [{ group: 'gateway.networking.k8s.io', kind: 'Gateway', name: gatewayRef.name }];
  }

  async deploy() {
    const policyOverrides = {
      apiVersion: policyApiVersion(this.edition),
      kind: POLICY_KIND[this.edition],
      metadata: {
        name: 'metric-labels',
        namespace: this.namespace,
        labels: { 'agentgateway.dev/feature': 'metric-labels' },
      },
      spec: {
        targetRefs: this.targetRefs,
        metrics: { attributes: { add: this.config.labels } },
      },
    };

    await this.applyYamlFile('traffic-policy.yaml', policyOverrides);
    this.log(`Metric labels applied (${this.config.labels.length} label(s))`, 'success');
  }

  async cleanup() {
    await this.deleteResource(POLICY_KIND[this.edition], 'metric-labels');
  }
}

export function createMetricLabelsFeature(config) {
  return new MetricLabelsFeature('metric-labels', config);
}

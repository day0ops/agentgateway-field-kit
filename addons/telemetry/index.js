import { Feature, FeatureManager } from '../../src/lib/feature.js';
import {
  EDITION_GATEWAY_NAME,
  EDITION_BASE_NAME,
  POLICY_KIND,
  policyApiVersion,
} from '../../src/lib/editions.js';
import {
  KubernetesHelper,
  CommandRunner,
  nlbSourceRangeAnnotations,
} from '../../src/lib/common.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile, readdir } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, 'config');
const DASHBOARDS_DIR = join(__dirname, 'dashboards');

// Helm chart versions
const PROMETHEUS_STACK_VERSION = '80.4.2';
const LOKI_VERSION = '6.6.2';
const TEMPO_DISTRIBUTED_VERSION = '1.29.0';
const ALLOY_VERSION = '0.12.0';
const OTEL_COLLECTOR_VERSION = '0.96.0';

/**
 * Telemetry Feature
 *
 * Installs a complete observability stack for agentgateway.
 *
 * Reference: https://github.com/solo-io/fe-enterprise-agentgateway-runbook/blob/main/002-set-up-monitoring-tools.md
 *
 * This feature installs:
 * - Prometheus and Grafana (kube-prometheus-stack)
 * - Grafana Tempo Distributed (trace aggregation with OTLP receiver)
 * - Grafana Loki (log aggregation)
 * - Grafana Alloy (log scraping from pods)
 * - PodMonitor for agentgateway metrics scraping
 * - EnterpriseAgentgatewayPolicy resources for trace collection
 * - Grafana dashboards (Overview, Budget, Performance, Control Plane)
 *
 * Configuration:
 * {
 *   telemetryNamespace: string,  // Default: 'telemetry'
 *   gatewayNamespace: string,    // Namespace where gateway policies are applied (default: 'agentgateway-system')
 *   enableLogs: boolean,          // Default: true
 *   enableTraces: boolean,        // Default: true
 *   enableMetrics: boolean,       // Default: true
 *   retention: string,            // Default: '120h' (5 days) - retention period for metrics, logs, traces
 *   grafanaServiceType: string,   // Default: 'LoadBalancer' - Grafana service type (ClusterIP, LoadBalancer, NodePort)
 *   grafanaSourceRanges: string | string[], // Optional: CIDR allowlist (e.g. VPN egress range)
 *                                 // for the Grafana LoadBalancer Service on AWS. Always pins
 *                                 // the scheme to internet-facing regardless - AWS LBC's own
 *                                 // default (internal) is unreachable from outside the VPC.
 *   nodeSelector: object          // Default: {} (e.g., { nodeclass: 'worker' })
 * }
 *
 * Requires the following environment variables (no defaults - deploy fails
 * cleanly via validate() if either is unset):
 *   GRAFANA_ADMIN_USERNAME - Grafana admin login username
 *   GRAFANA_ADMIN_PASSWORD - Grafana admin login password
 */
export class TelemetryFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    const chartVersions = config.chartVersions || {};
    this.prometheusStackVersion = chartVersions['kube-prom-stack'] || PROMETHEUS_STACK_VERSION;
    this.lokiVersion = chartVersions.loki || LOKI_VERSION;
    this.tempoVersion = chartVersions.tempo || TEMPO_DISTRIBUTED_VERSION;
    this.alloyVersion = chartVersions.alloy || ALLOY_VERSION;
    this.otelVersion = chartVersions.otel || OTEL_COLLECTOR_VERSION;
    this.telemetryNamespace = config.telemetryNamespace || 'telemetry';
    this.gatewayNamespace = config.gatewayNamespace || this.namespace;
    this.enableLogs = config.enableLogs !== false;
    this.enableTraces = config.enableTraces !== false;
    this.enableMetrics = config.enableMetrics !== false;
    this.retention = config.retention || '120h'; // 5 days default
    this.grafanaServiceType = config.grafanaServiceType || 'LoadBalancer';
    this.grafanaSourceRanges = config.grafanaSourceRanges || null;
    this.nodeSelector = config.nodeSelector || {};
    this.database = config.database || null;
    this.storageClass = this.database?.storageClass || config.storageClass || '';
    this.storageSize = this.database?.storageSize || config.storageSize || '50Gi';
    // External-dns hostnames for DNS record creation
    this.grafanaHostname = config.grafanaHostname || '';
    this.prometheusHostname = config.prometheusHostname || '';
    this.tempoHostname = config.tempoHostname || '';
    this.lokiHostname = config.lokiHostname || '';
    this.grafanaAdminUsername = process.env.GRAFANA_ADMIN_USERNAME || '';
    this.grafanaAdminPassword = process.env.GRAFANA_ADMIN_PASSWORD || '';
  }

  validate() {
    const missing = [
      !this.grafanaAdminUsername && 'GRAFANA_ADMIN_USERNAME',
      !this.grafanaAdminPassword && 'GRAFANA_ADMIN_PASSWORD',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(
        `Telemetry requires the following environment variable(s) to be set: ${missing.join(', ')}.\n` +
          'Set them before deploying, e.g.:\n' +
          '  export GRAFANA_ADMIN_USERNAME="admin"\n' +
          '  export GRAFANA_ADMIN_PASSWORD="<your-password>"'
      );
    }
    return true;
  }

  /**
   * Escape a value for safe use in `helm --set-string key=value`: Helm's strvals parser
   * treats an unescaped comma as the start of the next key=value pair and an unescaped
   * backslash as an escape character, so either would corrupt or truncate the value.
   */
  static helmSetEscape(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/,/g, '\\,');
  }

  /**
   * Override applyYamlFile to use addon's config directory instead of features/
   */
  async applyYamlFile(filename, overrides = {}) {
    const yaml = (await import('js-yaml')).default;
    const configPath = join(CONFIG_DIR, filename);

    try {
      const content = await readFile(configPath, 'utf8');
      let resource = yaml.load(content);

      if (resource.metadata && resource.metadata.namespace !== this.namespace) {
        resource.metadata.namespace = this.namespace;
      }

      if (Object.keys(overrides).length > 0) {
        resource = this.deepMerge(resource, overrides);
      }

      await this.applyResource(resource);
    } catch (error) {
      throw new Error(`Failed to apply YAML file ${filename}: ${error.message}`);
    }
  }

  /**
   * Build Helm --set args for nodeSelector
   */
  buildNodeSelectorArgs(prefix) {
    const args = [];
    const pathPrefix = prefix ? `${prefix}.` : '';
    for (const [key, value] of Object.entries(this.nodeSelector)) {
      args.push('--set', `${pathPrefix}nodeSelector.${key}=${value}`);
    }
    return args;
  }

  async deploy() {
    this.log('Installing observability stack...', 'info');

    // Step 1: Create telemetry namespace
    await KubernetesHelper.ensureNamespace(this.telemetryNamespace, this.spinner);
    this.log(`Namespace '${this.telemetryNamespace}' ready`, 'info');

    // Step 2: Install Tempo first (needed for Grafana datasource)
    if (this.enableTraces) {
      await this.installTempo();
    }

    // Step 3: Install Loki (needed for Grafana datasource)
    if (this.enableLogs) {
      await this.installLoki();
      await this.installAlloy();
    }

    // Step 4: Install Prometheus and Grafana with datasources configured
    await this.installPrometheusStack();

    // Step 5: Install Grafana dashboards
    await this.installDashboards();

    // The proxy/control-plane pod labels and Gateway object name all differ per edition
    // (enterprise: 'agentgateway-gw' proxy / 'enterprise-agentgateway' control plane;
    // opensource: 'agentgateway-oss-gw' proxy / 'agentgateway' control plane) - never the
    // bare 'agentgateway' the static YAML files default to. FeatureManager.getGatewayRef()
    // is set from the resolved edition at the start of `base install`/`install-local`, so
    // reverse-map it back to the edition to look up the matching control-plane name too.
    const gatewayRef = FeatureManager.getGatewayRef();
    const resolvedEdition =
      Object.entries(EDITION_GATEWAY_NAME).find(([, name]) => name === gatewayRef.name)?.[0] ||
      'enterprise';
    const controlPlaneName = EDITION_BASE_NAME[resolvedEdition];

    // Step 6: Create PodMonitors for agentgateway metrics
    if (this.enableMetrics) {
      await this.applyYamlFile('pod-monitor.yaml', {
        spec: { selector: { matchLabels: { 'app.kubernetes.io/name': gatewayRef.name } } },
      });
      await this.applyYamlFile('pod-monitor-control-plane.yaml', {
        spec: { selector: { matchLabels: { 'app.kubernetes.io/name': controlPlaneName } } },
      });
      // ServiceMonitor for kubelet/cAdvisor (container CPU/memory metrics on Talos)
      await this.applyYamlFile('service-monitor-kubelet.yaml');
    }

    // Step 7: Create per-edition Policy resources (EnterpriseAgentgatewayPolicy on
    // enterprise, AgentgatewayPolicy on opensource - same spec.frontend.{accessLog,tracing}
    // schema on both, only the CRD group/kind differs). The static YAML files default to
    // the enterprise kind, so it's overridden here for opensource.
    const gatewayTargetRefs = [
      { group: 'gateway.networking.k8s.io', kind: 'Gateway', name: gatewayRef.name },
    ];
    const policyOverrides = {
      apiVersion: policyApiVersion(resolvedEdition),
      kind: POLICY_KIND[resolvedEdition],
      metadata: { namespace: this.gatewayNamespace },
      spec: { targetRefs: gatewayTargetRefs },
    };
    if (this.enableLogs) {
      await this.applyYamlFile('logging-policy.yaml', policyOverrides);
      await this.applyYamlFile('reference-grant-logs.yaml');
    }
    if (this.enableTraces) {
      // Deploy fan-out collector to route traces to both Solo UI (ClickHouse) and Tempo (Grafana)
      await this.installFanOutCollector();
      // Apply gateway tracing policy (routes traces from agentgateway to fan-out-collector)
      await this.applyYamlFile('tracing-policy.yaml', policyOverrides);
      await this.applyYamlFile('reference-grant-traces.yaml');
    }

    this.log('Observability stack installed successfully', 'success');
    this.accessHint = this.grafanaHostname
      ? `Grafana: http://${this.grafanaHostname}`
      : `Grafana: kubectl port-forward svc/kube-prometheus-stack-grafana -n ${this.telemetryNamespace} 3000:80`;
  }

  /**
   * Install fan-out OTEL collector for routing traces to multiple backends
   * Routes to both solo-enterprise-telemetry-collector (ClickHouse) and tempo-distributor (Grafana)
   *
   * To enable fan-out, configure solo-ui addon with:
   *   tracingBackend: { name: 'fan-out-collector', namespace: 'telemetry', port: 4317 }
   */
  async installFanOutCollector() {
    this.log('Installing fan-out collector for trace routing...', 'info');

    try {
      await CommandRunner.run(
        'helm',
        [
          'repo',
          'add',
          'open-telemetry',
          'https://open-telemetry.github.io/opentelemetry-helm-charts',
        ],
        { ignoreError: true }
      );
      await CommandRunner.run('helm', ['repo', 'update', 'open-telemetry'], { ignoreError: true });
    } catch (_error) {}

    const helmArgs = [
      'upgrade',
      '-i',
      'fan-out-collector',
      'open-telemetry/opentelemetry-collector',
      '-n',
      this.telemetryNamespace,
      '--version',
      this.otelVersion,
      '-f',
      join(CONFIG_DIR, 'fan-out-collector-values.yaml'),
      '--create-namespace',
      '--wait',
      '--timeout',
      '5m',
    ];
    await KubernetesHelper.helm(helmArgs);
    await this.waitForDeployment('fan-out-collector', 120);

    await this.applyYamlFile('fan-out-collector-reference-grant.yaml');

    this.log('Fan-out collector installed', 'info');
    this.log(
      'Configure solo-ui with tracingBackend: { name: "fan-out-collector", namespace: "telemetry" }',
      'info'
    );
  }

  /**
   * Apply a YAML file containing multiple documents (separated by ---)
   */
  async applyMultiDocYamlFile(filename, vars = {}) {
    const yaml = (await import('js-yaml')).default;
    const configPath = join(CONFIG_DIR, filename);

    try {
      let content = await readFile(configPath, 'utf8');
      if (Object.keys(vars).length > 0) {
        content = content.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
      }
      const documents = yaml.loadAll(content);

      for (const doc of documents) {
        if (doc) {
          await this.applyResource(doc);
        }
      }
    } catch (error) {
      throw new Error(`Failed to apply multi-doc YAML file ${filename}: ${error.message}`);
    }
  }

  async cleanup() {
    this.log('Cleaning up observability stack...', 'info');

    // Reverse the same gatewayRef -> edition lookup used in deploy() to delete the
    // right Policy kind (EnterpriseAgentgatewayPolicy vs AgentgatewayPolicy).
    const gatewayRef = FeatureManager.getGatewayRef();
    const resolvedEdition =
      Object.entries(EDITION_GATEWAY_NAME).find(([, name]) => name === gatewayRef.name)?.[0] ||
      'enterprise';
    const policyKind = POLICY_KIND[resolvedEdition];

    await this.deleteResource(policyKind, 'logging-policy', this.gatewayNamespace);
    await this.deleteResource(policyKind, 'tracing-policy', this.gatewayNamespace);

    // Delete PodMonitors and ServiceMonitors
    await this.deleteResource('PodMonitor', 'agentgateway-metrics', this.telemetryNamespace);
    await this.deleteResource(
      'PodMonitor',
      'agentgateway-control-plane-metrics',
      this.telemetryNamespace
    );
    await this.deleteResource('ServiceMonitor', 'kubelet', this.telemetryNamespace);

    // Delete ReferenceGrants
    await this.deleteResource('ReferenceGrant', 'allow-loki-access', this.telemetryNamespace);

    // Uninstall fan-out collector Helm release
    try {
      await CommandRunner.run(
        'helm',
        ['uninstall', 'fan-out-collector', '-n', this.telemetryNamespace],
        { ignoreError: true }
      );
    } catch (_error) {}
    await this.deleteResource(
      'ReferenceGrant',
      'allow-fan-out-collector-access',
      this.telemetryNamespace
    );

    // Delete dashboard ConfigMaps
    const dashboardNames = [
      'agentgateway-overview',
      'agentgateway-cost-control',
      'agentgateway-performance',
      'agentgateway-control-plane',
    ];
    for (const name of dashboardNames) {
      await this.deleteResource('ConfigMap', `dashboard-${name}`, this.telemetryNamespace);
    }

    // Uninstall Helm charts
    const releases = ['alloy', 'loki', 'tempo', 'kube-prometheus-stack'];

    for (const release of releases) {
      try {
        await CommandRunner.run('helm', ['uninstall', release, '-n', this.telemetryNamespace], {
          ignoreError: true,
        });
      } catch (_error) {
        // Ignore errors - release may not exist
      }
    }

    this.log('Observability stack cleaned up', 'success');
  }

  /**
   * Install Grafana Tempo Distributed
   */
  async installTempo() {
    this.log('Installing Grafana Tempo...', 'info');

    try {
      await CommandRunner.run(
        'helm',
        ['repo', 'add', 'grafana', 'https://grafana.github.io/helm-charts'],
        { ignoreError: true }
      );
      await CommandRunner.run('helm', ['repo', 'update', 'grafana'], { ignoreError: true });
    } catch (_error) {
      // Repo might already exist
    }

    const helmArgs = [
      'upgrade',
      '-i',
      'tempo',
      'grafana/tempo-distributed',
      '-n',
      this.telemetryNamespace,
      '--version',
      this.tempoVersion,
      '-f',
      join(CONFIG_DIR, 'tempo-values.yaml'),
      '--create-namespace',
      '--wait',
      '--set',
      `ingester.persistence.size=${this.storageSize}`,
      '--set',
      `compactor.persistence.size=${this.storageSize}`,
      '--set',
      `metricsGenerator.persistence.size=${this.storageSize}`,
      ...(this.storageClass
        ? [
            '--set',
            `ingester.persistence.storageClass=${this.storageClass}`,
            '--set',
            `compactor.persistence.storageClass=${this.storageClass}`,
            '--set',
            `metricsGenerator.persistence.storageClass=${this.storageClass}`,
          ]
        : []),
    ];
    await KubernetesHelper.helm(helmArgs);

    // Wait for key components
    await this.waitForDeployment('tempo-distributor', 120);
    await this.waitForDeployment('tempo-query-frontend', 120);
  }

  /**
   * Install Grafana Loki
   */
  async installLoki() {
    this.log('Installing Grafana Loki...', 'info');

    try {
      await CommandRunner.run(
        'helm',
        ['repo', 'add', 'grafana', 'https://grafana.github.io/helm-charts'],
        { ignoreError: true }
      );
      await CommandRunner.run('helm', ['repo', 'update', 'grafana'], { ignoreError: true });
    } catch (_error) {
      // Repo might already exist
    }

    const helmArgs = [
      'upgrade',
      '-i',
      'loki',
      'grafana/loki',
      '-n',
      this.telemetryNamespace,
      '--version',
      this.lokiVersion,
      '-f',
      join(CONFIG_DIR, 'loki-values.yaml'),
      '--create-namespace',
      '--wait',
      '--set',
      `loki.limits_config.retention_period=${this.retention}`,
      '--set',
      `loki.limits_config.reject_old_samples_max_age=${this.retention}`,
      ...this.buildNodeSelectorArgs('singleBinary'),
      ...(this.storageClass
        ? [
            '--set',
            `minio.persistence.storageClass=${this.storageClass}`,
            '--set',
            `minio.persistence.size=${this.storageSize}`,
            '--set',
            `singleBinary.persistence.storageClass=${this.storageClass}`,
            '--set',
            `singleBinary.persistence.size=${this.storageSize}`,
          ]
        : []),
    ];
    await KubernetesHelper.helm(helmArgs);

    await this.waitForStatefulSet('loki', 120);
  }

  /**
   * Install Grafana Alloy for log scraping
   */
  async installAlloy() {
    this.log('Installing Grafana Alloy for log collection...', 'info');

    const helmArgs = [
      'upgrade',
      '-i',
      'alloy',
      'grafana/alloy',
      '-n',
      this.telemetryNamespace,
      '--version',
      this.alloyVersion,
      '-f',
      join(CONFIG_DIR, 'alloy-values.yaml'),
      '--create-namespace',
      '--wait',
    ];
    await KubernetesHelper.helm(helmArgs);

    await this.waitForDaemonSet('alloy', 120);
  }

  /**
   * Install Prometheus and Grafana stack
   */
  async installPrometheusStack() {
    this.log('Installing Prometheus and Grafana...', 'info');

    try {
      await CommandRunner.run(
        'helm',
        [
          'repo',
          'add',
          'prometheus-community',
          'https://prometheus-community.github.io/helm-charts',
        ],
        { ignoreError: true }
      );
      await CommandRunner.run('helm', ['repo', 'update', 'prometheus-community'], {
        ignoreError: true,
      });
    } catch (_error) {
      // Repo might already exist
    }

    const helmArgs = [
      'upgrade',
      '-i',
      'kube-prometheus-stack',
      'prometheus-community/kube-prometheus-stack',
      '-n',
      this.telemetryNamespace,
      '--version',
      this.prometheusStackVersion,
      '-f',
      join(CONFIG_DIR, 'prometheus-values.yaml'),
      '--create-namespace',
      '--wait',
      '--set',
      `prometheus.prometheusSpec.retention=${this.retention}`,
      '--set',
      `grafana.service.type=${this.grafanaServiceType}`,
      '--set-string',
      `grafana.adminUser=${TelemetryFeature.helmSetEscape(this.grafanaAdminUsername)}`,
      '--set-string',
      `grafana.adminPassword=${TelemetryFeature.helmSetEscape(this.grafanaAdminPassword)}`,
      ...this.buildNodeSelectorArgs('prometheus.prometheusSpec'),
      ...this.buildNodeSelectorArgs('grafana'),
    ];

    if (this.storageClass) {
      helmArgs.push(
        '--set',
        `prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.storageClassName=${this.storageClass}`,
        '--set',
        `prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage=${this.storageSize}`
      );
    }

    // Add external-dns annotations for DNS record creation
    if (this.grafanaHostname) {
      helmArgs.push(
        '--set',
        `grafana.service.annotations.external-dns\\.alpha\\.kubernetes\\.io/hostname=${this.grafanaHostname}`
      );
    }
    // AWS LBC's own default scheme (when no annotation is present) is `internal`,
    // unreachable from outside the VPC -- always pin internet-facing explicitly.
    if (this.grafanaServiceType === 'LoadBalancer') {
      for (const [key, value] of Object.entries(
        nlbSourceRangeAnnotations(this.grafanaSourceRanges)
      )) {
        helmArgs.push(
          '--set',
          `grafana.service.annotations.${key.replaceAll('.', '\\.')}=${value}`
        );
      }
    }
    if (this.prometheusHostname) {
      helmArgs.push(
        '--set',
        `prometheus.service.annotations.external-dns\\.alpha\\.kubernetes\\.io/hostname=${this.prometheusHostname}`
      );
    }

    await KubernetesHelper.helm(helmArgs);

    await this.waitForDeployment('kube-prometheus-stack-operator', 120);
    await this.waitForDeployment('kube-prometheus-stack-grafana', 120);
    await this.waitForStatefulSet('prometheus-kube-prometheus-stack-prometheus', 120);
  }

  /**
   * Install Grafana dashboards as ConfigMaps
   */
  async installDashboards() {
    this.log('Installing Grafana dashboards...', 'info');

    try {
      const files = await readdir(DASHBOARDS_DIR);
      const dashboardFiles = files.filter(f => f.endsWith('.json'));

      for (const file of dashboardFiles) {
        const dashboardPath = join(DASHBOARDS_DIR, file);
        const content = await readFile(dashboardPath, 'utf8');
        const name = file.replace('.json', '');

        const configMap = {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: {
            name: `dashboard-${name}`,
            namespace: this.telemetryNamespace,
            labels: {
              grafana_dashboard: '1',
              'app.kubernetes.io/managed-by': 'agentgateway-demo',
            },
          },
          data: {
            [`${name}.json`]: content,
          },
        };

        await this.applyResource(configMap);
        this.log(`Dashboard '${name}' installed`, 'info');
      }
    } catch (error) {
      this.log(`Warning: Failed to install dashboards: ${error.message}`, 'warn');
    }
  }

  async waitForDeployment(name, timeout = 120) {
    this.log(`Waiting for deployment ${name} to be ready...`, 'info');

    try {
      await KubernetesHelper.waitForDeployment(
        this.telemetryNamespace,
        name,
        timeout,
        this.spinner
      );
    } catch (_error) {
      this.log(`Deployment ${name} may take longer to be ready`, 'warn');
    }
  }

  async waitForStatefulSet(name, timeout = 120) {
    this.log(`Waiting for statefulset ${name} to be ready...`, 'info');

    try {
      await KubernetesHelper.kubectl(
        [
          'wait',
          '--for=condition=ready',
          `statefulset/${name}`,
          '-n',
          this.telemetryNamespace,
          `--timeout=${timeout}s`,
        ],
        { spinner: this.spinner }
      );
    } catch (_error) {
      this.log(`StatefulSet ${name} may take longer to be ready`, 'warn');
    }
  }

  async waitForDaemonSet(name, timeout = 120) {
    this.log(`Waiting for daemonset ${name} to be ready...`, 'info');

    try {
      await KubernetesHelper.kubectl(
        [
          'rollout',
          'status',
          `daemonset/${name}`,
          '-n',
          this.telemetryNamespace,
          `--timeout=${timeout}s`,
        ],
        { spinner: this.spinner }
      );
    } catch (_error) {
      this.log(`DaemonSet ${name} may take longer to be ready`, 'warn');
    }
  }
}

export function createTelemetryFeature(config) {
  return new TelemetryFeature('telemetry', config);
}

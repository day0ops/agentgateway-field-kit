import { Feature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';

const DEFAULT_VERSION = '2.2.19';
const DEFAULT_NAMESPACE = 'opik';
const HELM_REPO_NAME = 'opik';
const HELM_REPO_URL = 'https://comet-ml.github.io/opik/';

/**
 * Opik Addon
 *
 * Self-hosts the full Comet Opik stack (backend, frontend, ClickHouse via the
 * Altinity operator, MySQL, Redis, ZooKeeper) via the official Helm chart, so
 * agentgateway traces can be scored by Opik's online evaluation rules instead of
 * pointing at Opik Cloud. minio is disabled by default (S3-compatible storage for
 * large attachments) for a smaller footprint - not needed to evaluate LLM traces.
 *
 * IMPORTANT, verified against Opik's own OpenTelemetry docs
 * (apps/opik-documentation/.../integrations/opentelemetry.mdx in comet-ml/opik):
 * Opik's OTLP ingestion is HTTP-only - "if you use the GRPC exporter you will face
 * errors" (Opik's own words). This is why the fan-out collector change wired up
 * alongside this addon uses an `otlphttp` exporter, not the `otlp` (gRPC) exporter
 * used for the Tempo/Solo UI backends already in that pipeline. The endpoint is
 * served through the opik-frontend Service (port 5173), not a dedicated ingestion
 * service - there isn't one.
 *
 * There is no OCI/registry chart for this addon to reuse the enterprise chart's
 * pinning pattern from; it publishes a real Helm repo instead
 * (https://comet-ml.github.io/opik/), so this follows the same
 * `helm repo add` + `helm upgrade -i` shape as addons/telemetry.
 *
 * Configuration:
 * {
 *   opikNamespace: string,   // Default: 'opik' - deliberately not `namespace`: FeatureManager.deploy()
 *                            // always pre-fills config.namespace with the global default
 *                            // (agentgateway-system) before this constructor runs, which would
 *                            // shadow an 'opik' default keyed on that same field (same reason
 *                            // addons/telemetry uses telemetryNamespace instead of namespace).
 *   chartVersions: { opik: string }, // Default: '2.2.19'
 *   minioEnabled: boolean,   // Default: false
 * }
 */
export class OpikFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.opikNamespace = config.opikNamespace || DEFAULT_NAMESPACE;
    this.chartVersion = config.chartVersions?.opik || DEFAULT_VERSION;
    this.minioEnabled = config.minioEnabled === true;
  }

  validate() {
    return true;
  }

  get frontendServiceHost() {
    return `opik-frontend.${this.opikNamespace}.svc.cluster.local`;
  }

  async deploy() {
    if (this.dryRun) {
      const comment = [
        '# Helm install (published repo - unlike semantic-router, no git clone needed):',
        `#   helm repo add ${HELM_REPO_NAME} ${HELM_REPO_URL}`,
        `#   helm upgrade -i opik ${HELM_REPO_NAME}/opik --namespace ${this.opikNamespace} \\`,
        `#     --version ${this.chartVersion} --create-namespace --set minio.enabled=${this.minioEnabled}`,
      ].join('\n');
      this._dryRunYaml.push(comment);
      this.accessHint = `Opik UI (once installed): kubectl port-forward svc/opik-frontend -n ${this.opikNamespace} 5173:5173`;
      return;
    }

    this.log(
      'Installing Opik (this pulls in ClickHouse, MySQL, Redis, ZooKeeper - expect several minutes)...',
      'info'
    );

    try {
      await CommandRunner.run('helm', ['repo', 'add', HELM_REPO_NAME, HELM_REPO_URL], {
        ignoreError: true,
      });
      await CommandRunner.run('helm', ['repo', 'update', HELM_REPO_NAME], { ignoreError: true });
    } catch {
      // repo may already exist
    }

    const helmArgs = [
      'upgrade',
      '-i',
      'opik',
      `${HELM_REPO_NAME}/opik`,
      '-n',
      this.opikNamespace,
      '--version',
      this.chartVersion,
      '--create-namespace',
      '--set',
      `minio.enabled=${this.minioEnabled}`,
      '--wait',
      '--timeout',
      '15m',
    ];
    await KubernetesHelper.helm(helmArgs);

    this.log('Opik installed', 'success');
    this.accessHint = `Opik UI: kubectl port-forward svc/opik-frontend -n ${this.opikNamespace} 5173:5173`;
  }

  async cleanup() {
    this.log('Cleaning up Opik...', 'info');
    try {
      await CommandRunner.run('helm', ['uninstall', 'opik', '-n', this.opikNamespace], {
        ignoreError: true,
      });
    } catch {
      // release may not exist
    }
    this.log(
      'Opik cleaned up (namespace left in place - delete it manually if no longer needed)',
      'success'
    );
  }
}

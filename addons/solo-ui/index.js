import { Feature, FeatureManager } from '../../src/lib/feature.js';
import {
  KubernetesHelper,
  CommandRunner,
  CertificateHelper,
  waitForPublicUrl,
  nlbSourceRangeAnnotations,
} from '../../src/lib/common.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, 'config');

// Solo Enterprise Management (Solo UI) Helm chart defaults
// Ref: https://docs.solo.io/agentgateway/2.2.x/install/ui/setup/#install-the-ui
const ENTERPRISE_AGENTGATEWAY_LICENSE = process.env.ENTERPRISE_AGENTGATEWAY_LICENSE;
const DEFAULT_SOLO_UI_MANAGEMENT_CHART_VERSION = '0.3.13';
const DEFAULT_SOLO_UI_MANAGEMENT_CHART_OCI =
  'oci://us-docker.pkg.dev/solo-public/solo-enterprise-helm/charts/management';
const DEFAULT_SOLO_UI_MANAGEMENT_CRDS_CHART_OCI =
  'oci://us-docker.pkg.dev/solo-public/solo-enterprise-helm/charts/management-crds';
const RELEASE_NAME = 'solo-ui';
const CRDS_RELEASE_NAME = 'solo-ui-crds';

/**
 * Solo UI Feature (Gloo UI / Solo Enterprise for agentgateway UI)
 *
 * Installs the Solo Enterprise management UI for agentgateway to gain insight into
 * AI backends, routes, policies, tracing, and more.
 *
 * Reference: https://docs.solo.io/agentgateway/2.2.x/install/ui/setup/#install-the-ui
 *
 * This service installs:
 * - Solo Enterprise management CRDs (management-crds chart)
 * - Solo Enterprise UI (solo-enterprise-ui)
 * - ClickHouse (for observability data, with configurable persistent storage)
 * - Management components
 *
 * Configuration:
 * {
 *   namespace: string,               // Default: 'agentgateway-system'
 *   managementChartVersion: string,  // Default: '0.3.13'
 *   managementChartOci: string,      // Default: OCI chart URL
 *   serviceType: string,             // Optional: e.g. 'LoadBalancer'; omit for port-forward
 *   sourceRanges: string | string[], // Optional: CIDR allowlist (e.g. VPN egress range) for
 *                                    // the LoadBalancer Service/Gateway on AWS. Always pins
 *                                    // the scheme to internet-facing regardless - AWS LBC's
 *                                    // own default (internal) is unreachable from outside the VPC.
 *   nodeSelector: object,            // Default: {} (e.g., { nodeclass: 'worker' })
 *   applyGatewayTracingPolicy: boolean, // Default: true — set false when telemetry addon owns the gateway tracing policy
 *   clickhouse: {                      // Optional: ClickHouse persistent volume config
 *     persistentVolume: {
 *       storageClass: string,        // PVC storage class (null = cluster default)
 *       size: string,                // e.g. '50Gi' (default: 10Gi)
 *     },
 *   },
 *   hostname: string,                // Optional: public hostname for HTTPS (e.g., 'ui.example.com')
 *   tls: {                           // Optional: TLS config (requires hostname)
 *     enabled: boolean,              // Default: false
 *     secretName: string,            // Default: 'solo-ui-tls'
 *     issuer: string,                // ClusterIssuer name (e.g., 'letsencrypt-dns')
 *   },
 *   oidc: {                          // Optional: OIDC auth config
 *     enabled: boolean,              // Default: false
 *     issuerUrl: string,             // Full OIDC issuer URL
 *     backendClientId: string,       // Confidential client ID
 *     backendClientSecret: string,   // Confidential client secret
 *     frontendClientId: string,      // Public PKCE client ID
 *   },
 *   features: {                       // Optional: products.agentgateway.features.* toggles
 *     costManagement: {              // Optional: Cost Management UI section (off by default)
 *       enabled: boolean,            // Default: false - sets products.agentgateway.features.cost-management=true
 *       writes: boolean,             // Default: true - set false for read-only (cost-management-writes=false)
 *     },
 *   },
 * }
 */
export class SoloUIFeature extends Feature {
  // Applies its own HTTPS Gateway (solo-enterprise-ui-https) on the shared GatewayClass and
  // waits for its hostname to resolve - the core agentgateway proxy/controller must already be
  // running for that Gateway to ever get programmed.
  static REQUIRES_GATEWAY = true;

  constructor(name, config) {
    super(name, config);
    this.namespace = config.namespace || this.namespace;
    this.chartVersion =
      config.managementChartVersion || config.version || DEFAULT_SOLO_UI_MANAGEMENT_CHART_VERSION;
    this.chartOci = config.managementChartOci || DEFAULT_SOLO_UI_MANAGEMENT_CHART_OCI;
    this.serviceType = config.serviceType || null;
    this.sourceRanges = config.sourceRanges || null;
    this.nodeSelector = config.nodeSelector || {};
    this.applyGatewayTracingPolicy = config.applyGatewayTracingPolicy !== false;
    this.clickhouse = config.clickhouse || null;
    this.hostname = config.hostname || null;
    this.tls = config.tls || null;
    this.oidc = config.oidc || null;
    this.costManagement = config.features?.costManagement || null;
  }

  getFeaturePath() {
    return '../addons/solo-ui';
  }

  validate() {
    if (!ENTERPRISE_AGENTGATEWAY_LICENSE) {
      throw new Error('ENTERPRISE_AGENTGATEWAY_LICENSE is required for Solo UI installation');
    }
    return true;
  }

  /**
   * Recursively flatten a nested object into Helm --set args.
   * @param {string} prefix - Helm values path prefix (e.g., 'clickhouse')
   * @param {object} obj - Values object to flatten
   * @returns {string[]} Array of --set arguments
   */
  buildHelmSetArgs(prefix, obj) {
    if (!obj) return [];
    const args = [];
    const flatten = (val, path) => {
      for (const [key, v] of Object.entries(val)) {
        const fullPath = path ? `${path}.${key}` : key;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          flatten(v, fullPath);
        } else {
          args.push('--set', `${fullPath}=${v}`);
        }
      }
    };
    flatten(obj, prefix);
    return args;
  }

  /**
   * Build Helm --set args for nodeSelector
   * @param {string} prefix - Helm values path prefix (e.g., 'clickhouse')
   * @returns {string[]} Array of --set arguments
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
    this.log('Installing Solo UI (Solo Enterprise for agentgateway management)...', 'info');

    await KubernetesHelper.ensureNamespace(this.namespace, this.spinner);
    this.log(`Namespace '${this.namespace}' ready`, 'info');

    if (this.oidc?.enabled) {
      await this.createOidcSecret();
    }

    await this.installManagementCrdsChart();
    await this.installManagementChart();
    await this.waitForPods();

    if (this.hostname && this.tls?.enabled) {
      await this.applyHttpsResources();
    }

    if (this.hostname && CertificateHelper.isExternalHostname(this.hostname)) {
      await waitForPublicUrl(this.hostname, {
        protocol: this.tls?.enabled ? 'https' : 'http',
        spinner: this.spinner,
        log: (msg, level) => this.log(msg, level),
      });
    }

    // Apply gateway tracing policy pointing to ClickHouse (solo-enterprise-telemetry-collector).
    // Skip when telemetry addon is installed with enableTraces (it owns the gateway tracing policy).
    if (this.applyGatewayTracingPolicy) {
      // targetRefs.name comes from FeatureManager.getGatewayRef() rather than the YAML's own
      // placeholder - the actual Gateway object name differs per edition (enterprise:
      // 'agentgateway-gw', opensource: 'agentgateway-oss-gw'), never the bare 'agentgateway'
      // the static YAML defaults to.
      const gatewayRef = FeatureManager.getGatewayRef();
      await this.applyYamlFile('tracing-policy.yaml', {
        spec: {
          targetRefs: [
            { group: 'gateway.networking.k8s.io', kind: 'Gateway', name: gatewayRef.name },
          ],
        },
      });
      this.log(
        'Gateway tracing policy applied (pointing to solo-enterprise-telemetry-collector)',
        'info'
      );
    }

    let accessHint;
    if (this.hostname) {
      accessHint = `Access at https://${this.hostname}/age/`;
    } else if (this.serviceType) {
      const address = await this.getServiceAddress('solo-enterprise-ui');
      accessHint = address
        ? `Access at http://${address}`
        : `Access via the '${this.serviceType}' service in namespace '${this.namespace}' (address pending)`;
    } else {
      accessHint = `Port-forward with: kubectl port-forward service/solo-enterprise-ui -n ${this.namespace} 4000:80 then open http://localhost:4000/age/`;
    }
    this.log('Solo UI installed successfully', 'success');
    this.accessHint = accessHint;
  }

  /**
   * Install the Solo Enterprise management CRDs Helm chart
   */
  async installManagementCrdsChart() {
    this.log('Installing management CRDs Helm chart...', 'info');

    const helmArgs = [
      'upgrade',
      '-i',
      CRDS_RELEASE_NAME,
      DEFAULT_SOLO_UI_MANAGEMENT_CRDS_CHART_OCI,
      '-n',
      this.namespace,
      '--version',
      this.chartVersion,
      '--create-namespace',
      '--wait',
      '--timeout',
      '5m',
    ];

    await KubernetesHelper.helm(helmArgs, { spinner: this.spinner });

    this.log('Management CRDs Helm chart installed', 'info');
  }

  /**
   * Install the Solo Enterprise management Helm chart (Solo UI + ClickHouse)
   */
  async installManagementChart() {
    this.log('Installing management Helm chart (Solo UI)...', 'info');

    const valuesFile = join(CONFIG_DIR, 'values.yaml');

    const helmArgs = [
      'upgrade',
      '-i',
      RELEASE_NAME,
      this.chartOci,
      '-n',
      this.namespace,
      '--version',
      this.chartVersion,
      '-f',
      valuesFile,
      '--create-namespace',
      '--set',
      'management-crds.enabled=false',
      '--wait',
      '--timeout',
      '10m',
      ...(ENTERPRISE_AGENTGATEWAY_LICENSE
        ? ['--set', `licensing.licenseKey=${ENTERPRISE_AGENTGATEWAY_LICENSE}`]
        : []),
      ...(this.serviceType ? ['--set', `service.type=${this.serviceType}`] : []),
      // AWS LBC's own default scheme (when no annotation is present) is `internal`,
      // unreachable from outside the VPC -- always pin internet-facing explicitly.
      ...(this.serviceType
        ? [
            '--set-json',
            `service.annotations=${JSON.stringify(nlbSourceRangeAnnotations(this.sourceRanges))}`,
          ]
        : []),
      ...(this.costManagement?.enabled
        ? ['--set', 'products.agentgateway.features.cost-management=true']
        : []),
      ...(this.costManagement?.enabled && this.costManagement.writes === false
        ? ['--set', 'products.agentgateway.features.cost-management-writes=false']
        : []),
      ...this.buildHelmSetArgs('clickhouse', this.clickhouse),
      ...(this.oidc?.enabled
        ? [
            '--set',
            `oidc.issuer=${this.oidc.issuerUrl}`,
            '--set',
            `ui.backend.oidc.clientId=${this.oidc.backendClientId}`,
            '--set',
            `ui.backend.oidc.secretRef=ui-backend-oidc-secret`,
            '--set',
            `ui.frontend.oidc.clientId=${this.oidc.frontendClientId}`,
            '--set',
            'rbac.roleMapping.roleMappings.admins=global.Admin',
            '--set',
            'rbac.roleMapping.roleMappings.readers=global.Reader',
            '--set',
            'rbac.roleMapping.roleMappings.writers=global.Writer',
          ]
        : []),
      ...this.buildNodeSelectorArgs('ui'),
      ...this.buildNodeSelectorArgs('clickhouse'),
    ];

    await KubernetesHelper.helm(helmArgs, { spinner: this.spinner });

    this.log('Management Helm chart installed', 'info');
  }

  /**
   * Wait for management and UI pods to be ready
   */
  async waitForPods() {
    this.log('Waiting for management and UI pods...', 'info');

    // Wait for solo-enterprise-ui deployment
    try {
      await KubernetesHelper.waitForDeployment(
        this.namespace,
        'solo-enterprise-ui',
        300,
        this.spinner
      );
    } catch (error) {
      this.log(`solo-enterprise-ui may still be starting: ${error.message}`, 'warn');
    }

    // ClickHouse may be a StatefulSet (e.g. management-clickhouse-shard0-0)
    try {
      await KubernetesHelper.kubectl(
        [
          'wait',
          '--for=condition=ready',
          'pod',
          '-l',
          'app.kubernetes.io/name=clickhouse',
          '-n',
          this.namespace,
          '--timeout=300s',
        ],
        { ignoreError: true, spinner: this.spinner }
      );
    } catch (error) {
      this.log('ClickHouse pods may use different labels; continuing', 'warn');
    }

    this.log('Solo UI and management components are ready', 'info');
  }

  async getServiceAddress(serviceName) {
    const jsonpathArgs = field => [
      'get',
      'svc',
      serviceName,
      '-n',
      this.namespace,
      '-o',
      `jsonpath={.status.loadBalancer.ingress[0].${field}}`,
    ];
    const ipResult = await KubernetesHelper.kubectl(jsonpathArgs('ip'), { ignoreError: true });
    const address = (ipResult.stdout || '').trim();
    if (address) return address;

    const hostResult = await KubernetesHelper.kubectl(jsonpathArgs('hostname'), {
      ignoreError: true,
    });
    return (hostResult.stdout || '').trim() || null;
  }

  async createOidcSecret() {
    this.log('Creating OIDC backend client secret...', 'info');
    await this.applyResource({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'ui-backend-oidc-secret',
        namespace: this.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'agentgateway-demo' },
      },
      type: 'Opaque',
      stringData: { clientSecret: this.oidc.backendClientSecret },
    });
    this.log('OIDC secret created', 'info');
  }

  async applyHttpsResources() {
    this.log(`Configuring HTTPS for Solo UI at https://${this.hostname}...`, 'info');

    const secretName = this.tls.secretName || 'solo-ui-tls';
    const issuerName = this.tls.issuer || 'letsencrypt-dns';

    await this.applyYamlFile('certificate.yaml', {
      spec: {
        secretName,
        issuerRef: { name: issuerName },
        dnsNames: [this.hostname],
      },
    });

    // Pass complete listener object — deepMerge replaces arrays wholesale
    await this.applyYamlFile('https-gateway.yaml', {
      spec: {
        listeners: [
          {
            name: 'https',
            port: 443,
            protocol: 'HTTPS',
            hostname: this.hostname,
            tls: {
              mode: 'Terminate',
              certificateRefs: [{ name: secretName, kind: 'Secret' }],
            },
            allowedRoutes: {
              namespaces: { from: 'All' },
            },
          },
        ],
        // AWS LBC's own default scheme (when no annotation is present) is `internal`,
        // unreachable from outside the VPC -- always pin internet-facing explicitly.
        infrastructure: {
          annotations: nlbSourceRangeAnnotations(this.sourceRanges),
        },
      },
    });

    await this.applyYamlFile('https-route.yaml', {
      spec: {
        hostnames: [this.hostname],
        rules: [
          {
            backendRefs: [{ name: 'solo-enterprise-ui', port: 80 }],
            matches: [{ path: { type: 'PathPrefix', value: '/' } }],
            filters: [
              {
                type: 'CORS',
                cors: {
                  allowCredentials: true,
                  allowOrigins: [`https://${this.hostname}`],
                  allowMethods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
                  allowHeaders: ['Content-Type', 'Authorization', 'X-Grpc-Web'],
                  exposeHeaders: ['Grpc-Status', 'Grpc-Message'],
                  maxAge: 86400,
                },
              },
            ],
          },
        ],
      },
    });

    await this.applyYamlFile('tracing-suppress-policy.yaml');

    this.log('HTTPS resources applied', 'info');
  }

  async cleanup() {
    this.log('Cleaning up Solo UI (management release)...', 'info');

    // Delete EnterpriseAgentgatewayPolicies
    await this.deleteResource('EnterpriseAgentgatewayPolicy', 'tracing-solo-ui', this.namespace);

    if (this.oidc?.enabled) {
      await this.deleteResource('Secret', 'ui-backend-oidc-secret', this.namespace);
    }

    if (this.hostname && this.tls?.enabled) {
      await this.deleteResource('EnterpriseAgentgatewayPolicy', 'solo-ui-no-trace', this.namespace);
      await this.deleteResource('HTTPRoute', 'solo-enterprise-ui', this.namespace);
      await this.deleteResource('Gateway', 'solo-enterprise-ui-https', this.namespace);
      await this.deleteResource('Certificate', 'solo-ui-tls', this.namespace);
    }

    try {
      await CommandRunner.run(
        'helm',
        ['uninstall', RELEASE_NAME, CRDS_RELEASE_NAME, '-n', this.namespace, '--wait'],
        { ignoreError: true }
      );
      this.log('Management Helm releases uninstalled', 'info');
    } catch (error) {
      // Ignore
    }

    this.log('Solo UI cleaned up', 'success');
  }
}

export function createSoloUIFeature(config) {
  return new SoloUIFeature('solo-ui', config);
}

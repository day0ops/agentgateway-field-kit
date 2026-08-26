import {
  Logger,
  KubernetesHelper,
  SpinnerLogger,
  CertificateHelper,
  waitForPublicUrl,
} from './common.js';
import { EnvironmentManager } from './environment.js';
import { readFile, writeFile, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { ProfileSchema } from './profile-schema.js';
import {
  EDITIONS,
  EDITION_BASE_NAME,
  EDITION_RELEASE_NAME,
  EDITION_GATEWAY_NAME,
  EDITION_OCI_REGISTRY,
  resolveEdition,
} from './editions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const DEFAULT_GATEWAY_YAML = join(PROJECT_ROOT, 'config', 'gateway', 'default-gateway.yaml');

const INSTALL_STATE_CONFIGMAP = 'agentgateway-install-state';
const AGENTGATEWAY_NAMESPACE = process.env.AGENTGATEWAY_NAMESPACE || 'agentgateway-system';
const AGENTGATEWAY_VERSION = process.env.AGENTGATEWAY_VERSION || '2.1.1';
const GATEWAY_API_VERSION = process.env.GATEWAY_API_VERSION || 'v1.4.0';
const AGENTGATEWAY_OCI_REGISTRY = EDITION_OCI_REGISTRY.enterprise;
const ENTERPRISE_AGENTGATEWAY_LICENSE = process.env.ENTERPRISE_AGENTGATEWAY_LICENSE;

export class AgentGatewayManager {
  /**
   * Load a profile YAML file and resolve environment templates (e.g. {{env.domains.keycloak}}).
   * @param {string} profileFile - Path to the profile YAML file
   * @returns {Promise<object>} Resolved profile object
   */
  static async loadProfile(profileFile) {
    const content = await readFile(profileFile, 'utf8');
    const raw = yaml.load(content);
    let profile = ProfileSchema.normalize(raw, profileFile);
    if (profile.environment) {
      try {
        const environment = await EnvironmentManager.load(profile.environment);
        profile = EnvironmentManager.resolveAllTemplates(profile, environment);
      } catch {
        // If environment loading fails, continue with unresolved profile
      }
    }
    return profile;
  }

  /**
   * Check if license key is available
   * @throws {Error} If license key is not provided
   */
  static checkLicenseKey() {
    if (!ENTERPRISE_AGENTGATEWAY_LICENSE) {
      throw new Error(
        'ENTERPRISE_AGENTGATEWAY_LICENSE environment variable is required for enterprise-agentgateway installation.\n' +
          'Please set it before running the installation:\n' +
          '  export ENTERPRISE_AGENTGATEWAY_LICENSE="your-license-key"'
      );
    }
  }

  /**
   * Add license key to Helm arguments
   * @param {Array} helmArgs - Array of Helm arguments to modify
   */
  static addLicenseKeyToHelmArgs(helmArgs) {
    if (ENTERPRISE_AGENTGATEWAY_LICENSE) {
      helmArgs.push('--set', `licensing.licenseKey=${ENTERPRISE_AGENTGATEWAY_LICENSE}`);
    }
  }
  static async installGatewayAPICRDs(
    gatewayApiVersion = GATEWAY_API_VERSION,
    channel = 'standard'
  ) {
    const spinner = new SpinnerLogger();
    const resolvedChannel = channel === 'experimental' ? 'experimental' : 'standard';
    spinner.start(`Installing Gateway API CRDs ${gatewayApiVersion} (${resolvedChannel})...`);

    try {
      await KubernetesHelper.kubectl([
        'apply',
        '--server-side',
        '-f',
        `https://github.com/kubernetes-sigs/gateway-api/releases/download/${gatewayApiVersion}/${resolvedChannel}-install.yaml`,
      ]);
      spinner.succeed(`Gateway API CRDs ${gatewayApiVersion} (${resolvedChannel}) installed`);
    } catch (error) {
      spinner.fail('Failed to install Gateway API CRDs');
      throw error;
    }
  }

  static resolveVersionAndRegistry(profile) {
    const edition = resolveEdition(profile?.edition);
    const baseName = EDITION_BASE_NAME[edition];
    const defaultOciRegistry = EDITION_OCI_REGISTRY[edition];

    const version = profile?.agentgateway?.version ?? AGENTGATEWAY_VERSION;
    const ociRegistry = profile?.agentgateway?.ociRegistry ?? defaultOciRegistry;
    const gatewayApiVersion = profile?.gatewayApi?.version ?? GATEWAY_API_VERSION;
    const gatewayApiChannel = profile?.gatewayApi?.channel ?? 'standard';
    const crdsVersion = profile?.['agentgateway-crds']?.version ?? version;
    const crdsOciRegistry = profile?.['agentgateway-crds']?.ociRegistry ?? ociRegistry;
    const crdsHelmValues = profile?.['agentgateway-crds']?.helmValues ?? null;
    const releaseName = process.env.AGENTGATEWAY_RELEASE || EDITION_RELEASE_NAME[edition];
    const chartName = baseName;
    const crdsReleaseName = process.env.AGENTGATEWAY_CRDS_RELEASE || `${baseName}-crds`;
    const crdsChartName = `${baseName}-crds`;
    return {
      edition,
      version,
      ociRegistry,
      gatewayApiVersion,
      gatewayApiChannel,
      crdsVersion,
      crdsOciRegistry,
      crdsHelmValues,
      releaseName,
      chartName,
      crdsReleaseName,
      crdsChartName,
    };
  }

  static async installAgentGatewayCRDs(
    version = AGENTGATEWAY_VERSION,
    ociRegistry = AGENTGATEWAY_OCI_REGISTRY,
    helmValues = null,
    releaseName = 'enterprise-agentgateway-crds',
    chartName = 'enterprise-agentgateway-crds'
  ) {
    const spinner = new SpinnerLogger();
    spinner.start(`Installing agentgateway CRDs ${version}...`);
    let tempValuesFile = null;

    try {
      await KubernetesHelper.ensureNamespace(AGENTGATEWAY_NAMESPACE, spinner);

      try {
        const helmArgs = [
          'upgrade',
          '-i',
          '--create-namespace',
          '--namespace',
          AGENTGATEWAY_NAMESPACE,
          '--version',
          version,
          releaseName,
          `${ociRegistry}/${chartName}`,
        ];

        if (helmValues) {
          tempValuesFile = join(tmpdir(), `agentgateway-crds-values-${Date.now()}.yaml`);
          await writeFile(tempValuesFile, yaml.dump(helmValues), 'utf8');
          helmArgs.push('-f', tempValuesFile);
        }

        await KubernetesHelper.helm(helmArgs);
        spinner.succeed(`agentgateway CRDs ${version} installed`);
      } catch (error) {
        spinner.fail('Failed to install agentgateway CRDs');
        // Log the actual error for debugging
        if (error.stdout) {
          Logger.error(`Helm output: ${error.stdout}`);
        }
        if (error.stderr) {
          Logger.error(`Helm error: ${error.stderr}`);
        }
        if (error.message) {
          Logger.error(`Error: ${error.message}`);
        }
        throw error;
      }
    } catch (error) {
      spinner.fail('Failed to install agentgateway CRDs');
      throw error;
    } finally {
      if (tempValuesFile) {
        try {
          await unlink(tempValuesFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  static async installCRDs(profileFile = null) {
    let profile = null;
    if (profileFile) {
      profile = await this.loadProfile(profileFile);
    }
    const {
      gatewayApiVersion,
      gatewayApiChannel,
      crdsVersion,
      crdsOciRegistry,
      crdsHelmValues,
      crdsReleaseName,
      crdsChartName,
    } = this.resolveVersionAndRegistry(profile);
    await this.installGatewayAPICRDs(gatewayApiVersion, gatewayApiChannel);
    await this.installAgentGatewayCRDs(
      crdsVersion,
      crdsOciRegistry,
      crdsHelmValues,
      crdsReleaseName,
      crdsChartName
    );
  }

  static async install(profileFile = null) {
    const spinner = new SpinnerLogger();
    let tempValuesFile = null;
    let profile = null;

    if (profileFile) {
      profile = await this.loadProfile(profileFile);
    }
    const { edition, version, ociRegistry, releaseName, chartName } =
      this.resolveVersionAndRegistry(profile);

    try {
      const profileMsg = profileFile ? ' with profile' : '';
      spinner.start(`Installing agentgateway ${version}${profileMsg}...`);

      const helmArgs = [
        'upgrade',
        '-i',
        '-n',
        AGENTGATEWAY_NAMESPACE,
        releaseName,
        `${ociRegistry}/${chartName}`,
        '--version',
        version,
      ];

      if (edition !== 'opensource') {
        this.addLicenseKeyToHelmArgs(helmArgs);
      }

      if (profileFile && profile) {
        if (profile.helmValues) {
          tempValuesFile = join(tmpdir(), `agentgateway-values-${Date.now()}.yaml`);
          const helmValuesYaml = yaml.dump(profile.helmValues);
          await writeFile(tempValuesFile, helmValuesYaml, 'utf8');
          helmArgs.push('-f', tempValuesFile);
        } else {
          helmArgs.push('-f', profileFile);
        }
      }

      helmArgs.push('--wait', '--timeout', '5m');

      try {
        await KubernetesHelper.helm(helmArgs);
        spinner.succeed('agentgateway installed successfully');
      } catch (error) {
        spinner.fail('Failed to install agentgateway Helm chart');
        // Log the actual error for debugging
        if (error.stdout) {
          Logger.error(`Helm output: ${error.stdout}`);
        }
        if (error.stderr) {
          Logger.error(`Helm error: ${error.stderr}`);
        }
        if (error.message) {
          Logger.error(`Error: ${error.message}`);
        }
        throw error;
      }

      // Wait for deployments - the chart creates a controller deployment named after the release
      spinner.start('Waiting for agentgateway components to be ready...');
      try {
        // The deployment name is typically the release name
        await KubernetesHelper.waitForDeployment(AGENTGATEWAY_NAMESPACE, releaseName, 300, spinner);
        spinner.succeed('All components are ready');
      } catch {
        // Deployment might have a different name, try to find it
        Logger.warn(`Deployment ${releaseName} not found, checking for other deployments...`);
        const deployments = await KubernetesHelper.kubectl(
          ['get', 'deployments', '-n', AGENTGATEWAY_NAMESPACE, '-o', 'name'],
          { ignoreError: true }
        );

        if (deployments.stdout && deployments.stdout.trim()) {
          Logger.info(`Found deployments: ${deployments.stdout.trim()}`);
          spinner.succeed('Components are ready (deployment check skipped)');
        } else {
          spinner.fail('No deployments found');
          throw new Error('No agentgateway deployments found in namespace');
        }
      }

      // Step 4: Apply additional resources from profile if any
      if (profile && profile.resources && profile.resources.length > 0) {
        spinner.start(
          `Applying ${profile.resources.length} additional resource(s) from profile...`
        );
        const profileDir = profileFile ? dirname(profileFile) : null;
        await this.applyProfileResources(profile.resources, profileDir, spinner);
        spinner.succeed('Profile resources applied successfully');
      }

      // Step 5: Process feature gates
      if (profile?.featureGates) {
        await this.processFeatureGates(profile.featureGates, spinner);
      }
    } catch (error) {
      spinner.fail('Failed to install agentgateway');
      // Clear spinner before logging detailed errors
      spinner.clear();

      // Log error details for debugging
      if (error.message) {
        Logger.error(`Installation error: ${error.message}`);
      }

      // Log Helm-specific errors if present
      if (error.stdout) {
        Logger.error(`Helm output: ${error.stdout}`);
      }
      if (error.stderr) {
        Logger.error(`Helm error: ${error.stderr}`);
      }

      // If no specific error details, show the error message
      if (!error.stdout && !error.stderr && error.message) {
        Logger.error(`Error: ${error.message}`);
      }

      // Show stack trace in debug mode
      if (error.stack && process.env.DEBUG) {
        Logger.debug(`Stack trace: ${error.stack}`);
      }

      throw error;
    } finally {
      // Clean up temporary values file
      if (tempValuesFile) {
        try {
          await unlink(tempValuesFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Apply additional Kubernetes resources from a profile
   * @param {Array} resources - Array of resource file paths (strings) or resource objects
   * @param {string} profileDir - Directory path where the profile file is located
   * @param {SpinnerLogger} spinner - Spinner logger
   */
  static async applyProfileResources(resources, profileDir, _spinner) {
    if (!resources || resources.length === 0) {
      return;
    }

    for (const resource of resources) {
      try {
        let resourceYaml;
        let resourceName = 'unknown';

        if (typeof resource === 'string') {
          const resourcePath = profileDir ? join(profileDir, resource) : resource;
          resourceName = resource;
          resourceYaml = await readFile(resourcePath, 'utf8');

          const docs = yaml.loadAll(resourceYaml).filter(Boolean);
          resourceName = docs
            .map(d => `${d.kind || 'Resource'} ${d.metadata?.name || resource}`)
            .join(', ');
        } else {
          resourceYaml = yaml.dump(resource);
          resourceName = `${resource.kind || 'Resource'} ${resource.metadata?.name || 'unknown'}`;
        }

        await KubernetesHelper.kubectl(['apply', '-f', '-'], { input: resourceYaml });
        Logger.debug(`Applied ${resourceName}`);
      } catch (error) {
        const resourceName =
          typeof resource === 'string'
            ? resource
            : `${resource.kind || 'Resource'} ${resource.metadata?.name || 'unknown'}`;
        throw new Error(`Failed to apply ${resourceName}: ${error.message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Feature gates
  // ---------------------------------------------------------------------------

  static async processFeatureGates(featureGates, spinner) {
    if (featureGates.injectExtAuthCustomCaCert) {
      await this.processInjectCaCert(featureGates.injectExtAuthCustomCaCert, spinner);
    }
  }

  static async processInjectCaCert(config, spinner) {
    if (!config.enabled) return;

    const sourceSecret = config.sourceSecret || 'keycloak-tls';
    const sourceNamespace = config.sourceNamespace || 'keycloak';
    const caSecretName = config.caSecretName || 'keycloak-ca';

    spinner.start('Copying CA certificate to agentgateway namespace...');

    const caCrt = await this.extractCaCertFromSecret(sourceSecret, sourceNamespace);
    if (!caCrt) {
      spinner.warn(
        `Could not extract CA certificate from ${sourceNamespace}/${sourceSecret} — skipping`
      );
      return;
    }

    await this.createCaSecret(caSecretName, caCrt);

    spinner.succeed(`CA secret '${caSecretName}' created in ${AGENTGATEWAY_NAMESPACE}`);
  }

  static async extractCaCertFromSecret(secretName, namespace) {
    try {
      const result = await KubernetesHelper.kubectl([
        'get',
        'secret',
        secretName,
        '-n',
        namespace,
        '-o',
        'jsonpath={.data.ca\\.crt}',
      ]);
      let b64 = (result.stdout || '').trim();

      if (!b64) {
        const fallback = await KubernetesHelper.kubectl([
          'get',
          'secret',
          secretName,
          '-n',
          namespace,
          '-o',
          'jsonpath={.data.tls\\.crt}',
        ]);
        b64 = (fallback.stdout || '').trim();
      }

      if (!b64) return null;
      return Buffer.from(b64, 'base64').toString('utf8');
    } catch (error) {
      Logger.warn(`Failed to read TLS secret ${namespace}/${secretName}: ${error.message}`);
      return null;
    }
  }

  static async createCaSecret(name, caCrt) {
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name,
        namespace: AGENTGATEWAY_NAMESPACE,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature-gate': 'injectExtAuthCustomCaCert',
        },
      },
      type: 'Opaque',
      stringData: { 'ca.crt': caCrt },
    };

    const yamlContent = yaml.dump(secret, { lineWidth: -1, indent: 2 });
    await KubernetesHelper.applyYaml(yamlContent);
  }

  /**
   * Detect which edition's Helm release (if any) is installed in the agentgateway namespace.
   * @returns {Promise<string|null>} The installed release name, or null if none is found
   */
  static async detectInstalledRelease() {
    if (!(await KubernetesHelper.isClusterAccessible())) {
      throw new Error(
        'Cannot reach the Kubernetes API — check your kubeconfig/credentials before continuing.'
      );
    }

    try {
      const result = await KubernetesHelper.helm(
        ['list', '-n', AGENTGATEWAY_NAMESPACE, '-o', 'json'],
        { ignoreError: true }
      );
      if (!result?.stdout) return null;
      const releases = JSON.parse(result.stdout);
      const names = new Set((releases || []).map(r => r.name));
      for (const edition of EDITIONS) {
        const releaseName = EDITION_RELEASE_NAME[edition];
        if (names.has(releaseName)) return releaseName;
      }
      return null;
    } catch {
      return null;
    }
  }

  static async verify() {
    Logger.info('Verifying agentgateway installation...');

    try {
      const releaseName = await this.detectInstalledRelease();
      if (releaseName) {
        Logger.success('agentgateway is installed');
        return true;
      }

      Logger.error('agentgateway is not installed');
      return false;
    } catch (error) {
      Logger.error('Failed to verify agentgateway');
      Logger.debug(`Verification error: ${error.message}`);
      return false;
    }
  }

  static async findProfileGatewayClass(profile, profileDir) {
    if (!profile?.resources?.length) return null;
    for (const resource of profile.resources) {
      try {
        let docs;
        if (typeof resource === 'string') {
          const resourcePath = profileDir ? join(profileDir, resource) : resource;
          docs = yaml.loadAll(await readFile(resourcePath, 'utf8'));
        } else {
          docs = [resource];
        }
        for (const parsed of docs) {
          if (parsed?.kind === 'GatewayClass') return parsed;
        }
      } catch {
        // skip unreadable resources
      }
    }
    return null;
  }

  static async findEnterpriseParameters(profile, profileDir) {
    if (!profile?.resources?.length) return null;
    for (const resource of profile.resources) {
      try {
        let docs;
        if (typeof resource === 'string') {
          const resourcePath = profileDir ? join(profileDir, resource) : resource;
          const content = await readFile(resourcePath, 'utf8');
          docs = yaml.loadAll(content);
        } else {
          docs = [resource];
        }
        for (const parsed of docs) {
          if (
            parsed?.kind === 'EnterpriseAgentgatewayParameters' &&
            !parsed?.spec?.sharedExtensions
          ) {
            return parsed;
          }
        }
      } catch {
        // skip unreadable resources
      }
    }
    return null;
  }

  static async installProxy(profileFile = null) {
    const spinner = new SpinnerLogger();

    const isInstalled = await this.verify();
    if (!isInstalled) {
      Logger.error('agentgateway is not installed. Run: agw base install first');
      throw new Error('agentgateway not installed');
    }

    spinner.start('Creating agentgateway Gateway...');

    let gatewayYaml = await readFile(DEFAULT_GATEWAY_YAML, 'utf8');
    const gateway = yaml.load(gatewayYaml);

    // Ensure namespace matches AGENTGATEWAY_NAMESPACE
    if (gateway.metadata.namespace !== AGENTGATEWAY_NAMESPACE) {
      gateway.metadata.namespace = AGENTGATEWAY_NAMESPACE;
    }

    // Wire parametersRef if profile has an EnterpriseAgentgatewayParameters resource
    let profile = null;
    let profileDir = null;
    if (profileFile) {
      profile = await this.loadProfile(profileFile);
      profileDir = dirname(profileFile);
    }
    const { edition } = this.resolveVersionAndRegistry(profile);

    // Use the resolved edition's own default Gateway name (byte-identical to the
    // hardcoded default in default-gateway.yaml for enterprise). Kept distinct from the
    // opensource release/chart name so the Gateway API controller's auto-provisioned
    // proxy Deployment/Service never collides with the controller's own resources.
    const gatewayName = EDITION_GATEWAY_NAME[edition];
    gateway.metadata.name = gatewayName;

    // Use custom GatewayClass from profile if defined; otherwise default to the
    // resolved edition's own default GatewayClass name (byte-identical to the
    // hardcoded default in default-gateway.yaml for enterprise).
    const profileGatewayClass = await this.findProfileGatewayClass(profile, profileDir);
    if (profileGatewayClass) {
      gateway.spec.gatewayClassName = profileGatewayClass.metadata.name;
      spinner.info(`Using GatewayClass '${profileGatewayClass.metadata.name}' from profile`);
    } else {
      gateway.spec.gatewayClassName = EDITION_BASE_NAME[edition];
    }

    const gatewayHostname = profile?.gateway?.hostname;

    // Wire the HTTPS listener + client-cert validation the gateway-mtls addon's CA chain
    // and server cert support, so profiles that opt in get an mTLS-ready Gateway from
    // the start instead of a usecase mutating the shared Gateway at deploy time. Kept off
    // port 443 - see the publicHttps block below for why.
    const mtls = profile?.gateway?.mtls;
    if (mtls?.enabled) {
      const mtlsPort = mtls.port || 8443;
      gateway.spec.listeners.push({
        name: 'https',
        port: mtlsPort,
        protocol: 'HTTPS',
        tls: {
          mode: 'Terminate',
          certificateRefs: [{ name: mtls.serverCertSecretName || 'gateway-mtls-server-tls' }],
        },
        allowedRoutes: { namespaces: { from: 'All' } },
      });
      gateway.spec.tls = {
        frontend: {
          default: {
            validation: {
              mode: 'AllowValidOnly',
              caCertificateRefs: [
                { name: mtls.caConfigMapName || 'gateway-mtls-ca', kind: 'ConfigMap', group: '' },
              ],
            },
          },
        },
      };
      spinner.info(
        `Enabling mTLS: HTTPS listener + client-cert validation added to Gateway on port ${mtlsPort}`
      );
    }

    // Wire a second, plain HTTPS listener (real cert, no client-cert requirement) on the
    // standard port 443, for clients that refuse non-TLS OAuth endpoints but can't present
    // an mTLS client cert (e.g. browser-based OAuth logins, which assume port 443 when a
    // URL doesn't spell one out) - see the gateway-mtls addon's publicHttps config.
    const publicHttps = profile?.gateway?.publicHttps;
    if (publicHttps?.enabled) {
      const port = publicHttps.port || 443;
      gateway.spec.listeners.push({
        name: 'https-public',
        port,
        protocol: 'HTTPS',
        tls: {
          mode: 'Terminate',
          certificateRefs: [{ name: publicHttps.certSecretName || 'gateway-public-tls' }],
        },
        allowedRoutes: { namespaces: { from: 'All' } },
      });
      gateway.spec.tls = gateway.spec.tls || {};
      gateway.spec.tls.frontend = gateway.spec.tls.frontend || {};
      gateway.spec.tls.frontend.perPort = gateway.spec.tls.frontend.perPort || [];
      gateway.spec.tls.frontend.perPort.push({ port, tls: {} });
      spinner.info(`Enabling public HTTPS: listener added to Gateway on port ${port}`);
    }

    // Wire Gateway-level parameters (logging, etc.)
    const enterpriseParams = await this.findEnterpriseParameters(profile, profileDir);
    if (enterpriseParams) {
      const paramsName = enterpriseParams.metadata?.name;
      gateway.spec = gateway.spec || {};
      gateway.spec.infrastructure = {
        parametersRef: {
          name: paramsName,
          group: 'enterpriseagentgateway.solo.io',
          kind: 'EnterpriseAgentgatewayParameters',
        },
      };
      spinner.info(`Attaching EnterpriseAgentgatewayParameters '${paramsName}' to Gateway`);
    }

    gatewayYaml = yaml.dump(gateway, { lineWidth: -1, indent: 2 });
    await KubernetesHelper.applyYaml(gatewayYaml, spinner);
    spinner.succeed('agentgateway Gateway created');

    // Wait for deployment
    spinner.start('Waiting for agentgateway proxy to be ready...');
    await KubernetesHelper.waitForDeployment(AGENTGATEWAY_NAMESPACE, gatewayName, 300, spinner);
    spinner.succeed('agentgateway proxy is ready');

    // Annotate the LB Service so external-dns (service source) creates the DNS record
    if (gatewayHostname && CertificateHelper.isExternalHostname(gatewayHostname)) {
      try {
        await KubernetesHelper.kubectl([
          'annotate',
          'service',
          gatewayName,
          '-n',
          AGENTGATEWAY_NAMESPACE,
          `external-dns.alpha.kubernetes.io/hostname=${gatewayHostname}`,
          '--overwrite',
        ]);
        spinner.info(`Annotated Service for DNS: ${gatewayHostname}`);
      } catch {
        Logger.warn(
          'Could not annotate Service for external-dns — DNS record may not be created automatically'
        );
      }
    }

    // Wait for DNS to propagate for the public gateway hostname
    if (gatewayHostname && CertificateHelper.isExternalHostname(gatewayHostname)) {
      await waitForPublicUrl(gatewayHostname, {
        protocol: 'http',
        port: 8080,
        spinner,
        log: (msg, level) => {
          const fn = Logger[level] || Logger.info;
          fn(msg);
        },
      });
    }

    // Get gateway address
    try {
      const address = await KubernetesHelper.getLoadBalancerAddress(
        AGENTGATEWAY_NAMESPACE,
        gatewayName,
        60
      );
      Logger.success(`Gateway address: ${address}`);
      console.log(`export AGENTGATEWAY_ADDRESS=${address}`);
    } catch {
      Logger.warn('LoadBalancer address not yet assigned');
      Logger.info('For local testing, use port-forwarding:');
      Logger.info(
        `  kubectl port-forward -n ${AGENTGATEWAY_NAMESPACE} deployment/${gatewayName} 8080:8080`
      );
    }
  }

  static async status() {
    Logger.info('Checking agentgateway status...');

    try {
      const releaseName = await this.detectInstalledRelease();
      const result = await KubernetesHelper.helm(['list', '-n', AGENTGATEWAY_NAMESPACE], {
        ignoreError: true,
      });

      if (!releaseName || !result.stdout.includes(releaseName)) {
        Logger.error('agentgateway is not installed');
        return;
      }

      console.log('\nHelm release:');
      const releaseResult = await KubernetesHelper.helm(['list', '-n', AGENTGATEWAY_NAMESPACE]);
      console.log(releaseResult.stdout);

      console.log('\nDeployments:');
      const deploymentsResult = await KubernetesHelper.kubectl([
        'get',
        'deployments',
        '-n',
        AGENTGATEWAY_NAMESPACE,
      ]);
      console.log(deploymentsResult.stdout);

      console.log('\nServices:');
      const servicesResult = await KubernetesHelper.kubectl([
        'get',
        'services',
        '-n',
        AGENTGATEWAY_NAMESPACE,
      ]);
      console.log(servicesResult.stdout);

      console.log('\nGateways:');
      const gatewaysResult = await KubernetesHelper.kubectl(
        ['get', 'gateways', '-n', AGENTGATEWAY_NAMESPACE],
        { ignoreError: true }
      );
      console.log(gatewaysResult.stdout || 'No gateways found');
    } catch (error) {
      Logger.error('Failed to get status');
      throw error;
    }
  }

  /**
   * Record which profile (if any) was used for the last successful install, so
   * `base clean -a` can later target only that profile's addons.
   * @param {{ profileName?: string|null }} [opts]
   */
  static async recordInstallState({ profileName } = {}) {
    if (!profileName) {
      await this.clearInstallState();
      return;
    }

    const configMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: INSTALL_STATE_CONFIGMAP,
        namespace: AGENTGATEWAY_NAMESPACE,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/component': 'install-state-tracker',
        },
      },
      data: {
        profile: profileName,
      },
    };

    const yamlContent = yaml.dump(configMap);
    await KubernetesHelper.applyYaml(yamlContent);
  }

  /**
   * Get the profile name recorded by the last successful install, if any.
   * @returns {Promise<string|null>}
   */
  static async getInstalledProfile() {
    try {
      const result = await KubernetesHelper.kubectl(
        [
          'get',
          'configmap',
          INSTALL_STATE_CONFIGMAP,
          '-n',
          AGENTGATEWAY_NAMESPACE,
          '-o',
          'jsonpath={.data.profile}',
        ],
        { ignoreError: true }
      );
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Clear the recorded install state.
   */
  static async clearInstallState() {
    try {
      await KubernetesHelper.kubectl([
        'delete',
        'configmap',
        INSTALL_STATE_CONFIGMAP,
        '-n',
        AGENTGATEWAY_NAMESPACE,
        '--ignore-not-found=true',
      ]);
    } catch {
      // Ignore errors
    }
  }

  static async uninstall({ deleteNamespace = false } = {}) {
    Logger.info('Uninstalling agentgateway...');

    // Check if we can connect to the cluster first
    if (!(await KubernetesHelper.isClusterAccessible())) {
      Logger.info('No cluster connection available, nothing to clean up');
      return;
    }

    try {
      const releaseName = await this.detectInstalledRelease();

      // Delete EnterpriseAgentGatewayParameters CRs before helm uninstall
      // Helm removes the CRD first, leaving CRs stuck in terminating if not pre-deleted
      Logger.info('Deleting EnterpriseAgentGatewayParameters resources...');
      await KubernetesHelper.kubectl(
        ['delete', 'enterpriseagentgatewayparameters', '--all', '-A', '--ignore-not-found'],
        { ignoreError: true }
      );

      if (releaseName) {
        await KubernetesHelper.helm([
          'uninstall',
          releaseName,
          '-n',
          AGENTGATEWAY_NAMESPACE,
          '--wait',
        ]);
        Logger.success('agentgateway uninstalled');
      } else {
        Logger.info('agentgateway helm release not found, skipping uninstall');
      }

      await this.clearInstallState();

      if (deleteNamespace) {
        const nsResult = await KubernetesHelper.kubectl(
          ['get', 'namespace', AGENTGATEWAY_NAMESPACE, '-o', 'name'],
          { ignoreError: true }
        );

        if (nsResult?.exitCode === 0 && nsResult?.stdout?.includes(AGENTGATEWAY_NAMESPACE)) {
          Logger.info(`Deleting namespace ${AGENTGATEWAY_NAMESPACE}...`);
          await KubernetesHelper.kubectl(
            ['delete', 'namespace', AGENTGATEWAY_NAMESPACE, '--wait=false'],
            { ignoreError: true }
          );
          Logger.success('Namespace deletion initiated');
        }
      }
    } catch (error) {
      Logger.error(`Failed to uninstall agentgateway: ${error.message}`);
      throw error;
    }
  }
}

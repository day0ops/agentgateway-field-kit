import { Feature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, 'config');

const EXTERNAL_DNS_VERSION = '1.21.1';

/**
 * external-dns Addon
 *
 * Deploys external-dns for automatic DNS record management.
 * Currently supports AWS Route53 only.
 *
 * Configuration:
 * {
 *   provider: 'route53',           // DNS provider (only route53 supported)
 *   zoneId: 'Z1234567890',         // Route53 hosted zone ID
 *   domainFilter: 'dev.example.com', // Domain to manage
 *   region: 'ap-southeast-2',      // AWS region
 *   txtOwnerId: 'agentgateway-demo', // TXT record owner ID
 * }
 */
export class ExternalDnsFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.version = config.version || EXTERNAL_DNS_VERSION;
    this.provider = config.provider || 'route53';
    this.zoneId = config.zoneId;
    this.domainFilter = config.domainFilter;
    this.region = config.region || 'ap-southeast-2';
    this.txtOwnerId = config.txtOwnerId || 'agentgateway-demo';
    this.namespace = config.namespace || 'external-dns';
  }

  validate() {
    if (this.provider !== 'route53') {
      throw new Error(
        `DNS provider '${this.provider}' not yet supported. Only 'route53' is implemented.`
      );
    }

    if (!this.domainFilter) {
      throw new Error('external-dns requires domainFilter configuration');
    }

    return true;
  }

  async deploy() {
    this.log('Installing external-dns...', 'info');

    await KubernetesHelper.ensureNamespace(this.namespace, this.spinner);

    // Add Helm repo
    try {
      await CommandRunner.run(
        'helm',
        ['repo', 'add', 'external-dns', 'https://kubernetes-sigs.github.io/external-dns/'],
        { ignoreError: true }
      );
      await CommandRunner.run('helm', ['repo', 'update', 'external-dns'], { ignoreError: true });
    } catch (_error) {
      // Repo might already exist
    }

    // Build Helm values
    // Note: external-dns chart v1.14+ uses provider.name instead of provider (string)
    // aws.region and aws.zoneType moved to env/extraArgs
    const extraArgs = ['--aws-zone-type=public'];
    if (this.zoneId) {
      extraArgs.push(`--zone-id-filter=${this.zoneId}`);
    }

    const helmArgs = [
      'upgrade',
      '-i',
      'external-dns',
      'external-dns/external-dns',
      '-n',
      this.namespace,
      '--version',
      this.version,
      '--create-namespace',
      '--wait',
      '--set',
      'provider.name=aws',
      '--set',
      `env[0].name=AWS_DEFAULT_REGION`,
      '--set',
      `env[0].value=${this.region}`,
      '--set',
      `domainFilters[0]=${this.domainFilter}`,
      '--set',
      `txtOwnerId=${this.txtOwnerId}`,
      '--set',
      'policy=sync',
      '--set',
      'sources[0]=service',
      '--set',
      'sources[1]=ingress',
      '--set',
      'sources[2]=gateway-httproute',
      ...extraArgs.flatMap((arg, i) => ['--set', `extraArgs[${i}]=${arg}`]),
    ];

    await KubernetesHelper.helm(helmArgs);

    // Wait for deployment
    await this.waitForDeployment('external-dns', 120);

    this.log('external-dns installed successfully', 'success');
  }

  async cleanup() {
    this.log('Cleaning up external-dns...', 'info');

    try {
      await CommandRunner.run('helm', ['uninstall', 'external-dns', '-n', this.namespace], {
        ignoreError: true,
      });
    } catch (_error) {
      // Release may not exist
    }

    this.log('external-dns cleaned up', 'success');
  }

  async waitForDeployment(name, timeout = 120) {
    this.log(`Waiting for deployment ${name} to be ready...`, 'info');

    try {
      await KubernetesHelper.waitForDeployment(this.namespace, name, timeout, this.spinner);
    } catch (_error) {
      this.log(`Deployment ${name} may take longer to be ready`, 'warn');
    }
  }
}

export function createExternalDnsFeature(config) {
  return new ExternalDnsFeature('external-dns', config);
}

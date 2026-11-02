import { Feature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';

const EXTERNAL_DNS_VERSION = '1.23.0';

/**
 * external-dns Addon
 *
 * Deploys external-dns for automatic DNS record management (AWS Route53 or Cloudflare).
 *
 * Configuration:
 * {
 *   provider: 'route53',           // DNS provider: 'route53' (default) | 'cloudflare'
 *   zoneId: 'Z1234567890',         // route53 only: hosted zone ID
 *   domainFilter: 'dev.example.com', // Domain to manage
 *   region: 'ap-southeast-2',      // route53 only: AWS region
 *   txtOwnerId: 'agentgateway-demo', // TXT record owner ID
 *   proxied: boolean,              // cloudflare only. Default: false -- Cloudflare's proxy
 *                                  // can't reach a private cluster IP, so DNS-only records
 *                                  // are the only sensible default. The API token is read
 *                                  // from CLOUDFLARE_API_TOKEN (no ambient-credential
 *                                  // mechanism like IRSA exists for Cloudflare).
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
    this.cloudflareProxied = config.proxied === true;
    this.cloudflareApiTokenSecretName = 'external-dns-cloudflare-api-token';
  }

  validate() {
    if (!['route53', 'cloudflare'].includes(this.provider)) {
      throw new Error(
        `DNS provider '${this.provider}' not yet supported. Supported: route53, cloudflare.`
      );
    }

    if (this.provider === 'cloudflare' && !process.env.CLOUDFLARE_API_TOKEN) {
      throw new Error(
        'external-dns: CLOUDFLARE_API_TOKEN environment variable is required for provider=cloudflare'
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

    if (this.provider === 'cloudflare') {
      await this.createCloudflareApiTokenSecret();
    }

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
    ];

    if (this.provider === 'cloudflare') {
      helmArgs.push(
        '--set',
        'provider.name=cloudflare',
        '--set',
        'env[0].name=CF_API_TOKEN',
        '--set',
        `env[0].valueFrom.secretKeyRef.name=${this.cloudflareApiTokenSecretName}`,
        '--set',
        'env[0].valueFrom.secretKeyRef.key=api-token'
      );
      // --cloudflare-proxied is a bare/presence flag -- `=false` fails to parse, and false is
      // already the binary's default, so only pass the flag at all when proxying is wanted.
      if (this.cloudflareProxied) {
        helmArgs.push('--set', 'extraArgs[0]=--cloudflare-proxied');
      }
    } else {
      // route53. chart v1.14+ uses provider.name (not provider string); aws.region and
      // aws.zoneType moved to env/extraArgs.
      const extraArgs = ['--aws-zone-type=public'];
      if (this.zoneId) {
        extraArgs.push(`--zone-id-filter=${this.zoneId}`);
      }
      helmArgs.push(
        '--set',
        'provider.name=aws',
        '--set',
        'env[0].name=AWS_DEFAULT_REGION',
        '--set',
        `env[0].value=${this.region}`,
        ...extraArgs.flatMap((arg, i) => ['--set', `extraArgs[${i}]=${arg}`])
      );
    }

    await KubernetesHelper.helm(helmArgs, this.spinner);

    // Wait for deployment
    await this.waitForDeployment('external-dns', 120);

    this.log('external-dns installed successfully', 'success');
  }

  /**
   * Reconcile the Secret the chart's CF_API_TOKEN env var reads from. Always re-applied
   * (not skip-if-exists) since the token can rotate.
   */
  async createCloudflareApiTokenSecret() {
    if (this.dryRun) {
      const secret = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: this.cloudflareApiTokenSecretName,
          namespace: this.namespace,
          labels: { 'app.kubernetes.io/managed-by': 'agentgateway-demo' },
        },
        stringData: { 'api-token': '<set CLOUDFLARE_API_TOKEN>' },
      };
      await this.applyResource(secret);
      return;
    }

    this.log('Reconciling Cloudflare API token secret...', 'info');
    await KubernetesHelper.createSecretFromLiteral(
      this.namespace,
      this.cloudflareApiTokenSecretName,
      'api-token',
      process.env.CLOUDFLARE_API_TOKEN,
      this.spinner
    );
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

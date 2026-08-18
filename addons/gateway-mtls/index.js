import { Feature } from '../../src/lib/feature.js';
import { KubernetesHelper, CertificateHelper } from '../../src/lib/common.js';
import { CertificateFeature } from '../../features/certificate/index.js';

const CERT_READY_TIMEOUT_SECONDS = 120;
const DEFAULT_DNS_NAMES = ['gateway-mtls.local'];

/**
 * Gateway mTLS Addon
 *
 * Provisions, once at install time, everything the shared Gateway needs to require and
 * validate client certificates on its TLS handshake (see
 * https://docs.solo.io/agentgateway/latest/setup/listeners/mtls/):
 *
 * - A self-signed CA chain (root Issuer -> CA Certificate (isCA: true) -> its ca.crt
 *   copied into a ConfigMap, since caCertificateRefs on the Gateway only accepts
 *   ConfigMap/Secret-by-key-"ca.crt" trust anchors and cert-manager has no native
 *   Secret->ConfigMap sync -> a CA-backed Issuer usecases issue client certs from).
 * - The Gateway's own HTTPS server certificate, via the existing `certificate` feature
 *   on the generic `selfsigned-issuer` (a separate, unrelated chain from the client CA
 *   above - server identity and client validation are independent concerns).
 *
 * `installProxy()` (src/lib/agentgateway.js) reads `profile.gateway.mtls` and wires the
 * Gateway's `https` listener + `spec.tls.frontend.default.validation` using this addon's
 * default resource names, so a profile only needs `gateway.mtls.enabled: true` plus this
 * addon in its `addons:` list (after `cert-manager`) to get a fully-formed Gateway from
 * the start. Issuing actual client certificates (for positive/negative test cases) is a
 * separate, usecase-level step - see the `frontend-mtls` feature.
 *
 * Optionally also issues a second, plain (non-mTLS) HTTPS certificate via the real
 * `letsencrypt-dns` ClusterIssuer when `config.publicHttps.enabled` - for a Gateway
 * listener that needs to be reachable by strict OAuth 2.1 clients (which refuse
 * non-TLS token endpoints) without requiring a client certificate on every request
 * the way the mTLS listener does. `installProxy()` reads `profile.gateway.publicHttps`
 * to wire the matching listener + a `spec.tls.frontend.perPort` override that exempts
 * that port from the mTLS listener's default client-cert requirement.
 *
 * Configuration:
 * {
 *   name: string,        // Resource name prefix (default: 'gateway-mtls')
 *   dnsNames: string[],  // DNS names for the Gateway's server certificate
 *                        // (default: ['gateway-mtls.local'])
 *   publicHttps: {
 *     enabled: boolean,     // default: false
 *     dnsNames: string[],  // required if enabled - must be real, publicly resolvable names
 *     issuer: string,      // ClusterIssuer name (default: 'letsencrypt-dns')
 *   },
 * }
 */
export class GatewayMtlsFeature extends Feature {
  get prefix() {
    return this.config.name || 'gateway-mtls';
  }

  get dnsNames() {
    return this.config.dnsNames || DEFAULT_DNS_NAMES;
  }

  get rootIssuerName() {
    return `${this.prefix}-ca-issuer`;
  }

  get caCertName() {
    return `${this.prefix}-ca`;
  }

  get caSecretName() {
    return `${this.prefix}-ca-secret`;
  }

  get caConfigMapName() {
    return `${this.prefix}-ca`;
  }

  get clientCaIssuerName() {
    return `${this.prefix}-client-ca-issuer`;
  }

  get serverCertName() {
    return `${this.prefix}-server-tls`;
  }

  get publicHttps() {
    return this.config.publicHttps?.enabled ? this.config.publicHttps : null;
  }

  get publicCertName() {
    // Not derived from this.prefix ('gateway-mtls' by default) - this cert is plain
    // one-way TLS, unrelated to the mTLS CA chain the rest of this addon provisions.
    return 'gateway-public-tls';
  }

  get labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
    };
  }

  async deploy() {
    this.log('Provisioning gateway mTLS CA chain and server certificate...', 'info');

    await this.deployRootIssuer();
    await this.deployCaCertificate();
    await this.copyCaCertToConfigMap();
    await this.deployClientCaIssuer();
    await this.deployServerCertificate();

    if (this.publicHttps) {
      await this.deployPublicCertificate();
    }

    this.log('Gateway mTLS CA chain and server certificate ready', 'success');
  }

  async deployRootIssuer() {
    const issuer = {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Issuer',
      metadata: {
        name: this.rootIssuerName,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: { selfSigned: {} },
    };
    await this.applyResource(issuer);
  }

  async deployCaCertificate() {
    const certificate = {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: {
        name: this.caCertName,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        isCA: true,
        commonName: `${this.prefix} CA`,
        secretName: this.caSecretName,
        issuerRef: { name: this.rootIssuerName, kind: 'Issuer' },
      },
    };
    await this.applyResource(certificate);

    if (!this.dryRun) {
      const ready = await CertificateHelper.waitForCertificate(
        this.namespace,
        this.caCertName,
        CERT_READY_TIMEOUT_SECONDS
      );
      if (!ready) {
        throw new Error(`Certificate '${this.caCertName}' did not become Ready in time`);
      }
    }
  }

  async copyCaCertToConfigMap() {
    let caCrtPem = '<extracted from CA secret after apply>';

    if (!this.dryRun) {
      const result = await KubernetesHelper.kubectl([
        'get',
        'secret',
        this.caSecretName,
        '-n',
        this.namespace,
        '-o',
        'jsonpath={.data.ca\\.crt}',
      ]);
      const b64 = (result.stdout || '').trim();
      if (!b64) {
        throw new Error(`ca.crt not found in secret ${this.namespace}/${this.caSecretName}`);
      }
      caCrtPem = Buffer.from(b64, 'base64').toString('utf8');
    }

    const configMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: this.caConfigMapName,
        namespace: this.namespace,
        labels: this.labels,
      },
      data: { 'ca.crt': caCrtPem },
    };
    await this.applyResource(configMap);
  }

  async deployClientCaIssuer() {
    const issuer = {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Issuer',
      metadata: {
        name: this.clientCaIssuerName,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: { ca: { secretName: this.caSecretName } },
    };
    await this.applyResource(issuer);
  }

  async deployServerCertificate() {
    const cert = new CertificateFeature(this.name, {
      namespace: this.namespace,
      name: this.serverCertName,
      secretName: this.serverCertName,
      dnsNames: this.dnsNames,
    });
    cert.setSpinner(this.spinner);
    cert.adoptParentContext(this);
    await cert.deploy();
  }

  async deployPublicCertificate() {
    const cert = new CertificateFeature(this.name, {
      namespace: this.namespace,
      name: this.publicCertName,
      secretName: this.publicCertName,
      dnsNames: this.publicHttps.dnsNames,
      issuer: this.publicHttps.issuer || 'letsencrypt-dns',
    });
    cert.setSpinner(this.spinner);
    cert.adoptParentContext(this);
    await cert.deploy();
  }

  async cleanup() {
    this.log('Cleaning up gateway-mtls addon...', 'info');
    await this.deleteResource('Certificate', this.serverCertName, this.namespace);
    await this.deleteResource('Secret', this.serverCertName, this.namespace);
    await this.deleteResource('Certificate', this.publicCertName, this.namespace);
    await this.deleteResource('Secret', this.publicCertName, this.namespace);
    await this.deleteResource('Issuer', this.clientCaIssuerName, this.namespace);
    await this.deleteResource('ConfigMap', this.caConfigMapName, this.namespace);
    await this.deleteResource('Certificate', this.caCertName, this.namespace);
    await this.deleteResource('Issuer', this.rootIssuerName, this.namespace);
    await this.deleteResource('Secret', this.caSecretName, this.namespace);
    this.log('gateway-mtls addon cleaned up', 'success');
  }
}

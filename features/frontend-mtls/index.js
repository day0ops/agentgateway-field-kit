import { Feature } from '../../src/lib/feature.js';
import { CertificateHelper } from '../../src/lib/common.js';

const CERT_READY_TIMEOUT_SECONDS = 120;
const DEFAULT_CA_ISSUER_NAME = 'gateway-mtls-client-ca-issuer';

/**
 * Frontend mTLS Feature
 *
 * Issues a client certificate off the CA-backed Issuer the `gateway-mtls` addon
 * provisions once at install time (see addons/gateway-mtls), so a request can present
 * a certificate the Gateway's `spec.tls.frontend.default.validation` trusts during the
 * TLS handshake itself (see https://docs.solo.io/agentgateway/latest/setup/listeners/mtls/).
 *
 * Deliberately kept usecase-level rather than folded into the addon: future usecases can
 * mint different client certs off the same CA (expired, wrong-CA, revoked) for negative
 * tests without ever touching the shared Gateway or its CA chain.
 *
 * Configuration:
 * {
 *   name: string,          // Resource name prefix (default: 'frontend-mtls')
 *   caIssuerName: string,  // CA-backed Issuer to issue from
 *                          // (default: 'gateway-mtls-client-ca-issuer', the gateway-mtls addon's default)
 * }
 */
export class FrontendMtlsFeature extends Feature {
  get prefix() {
    return this.config.name || 'frontend-mtls';
  }

  get caIssuerName() {
    return this.config.caIssuerName || DEFAULT_CA_ISSUER_NAME;
  }

  get clientCertName() {
    return `${this.prefix}-client`;
  }

  get clientSecretName() {
    return `${this.prefix}-client-secret`;
  }

  get labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
    };
  }

  async deploy() {
    this.log('Issuing frontend mTLS client certificate...', 'info');
    await this.deployClientCertificate();
    this.log('Frontend mTLS client certificate ready', 'success');
  }

  async deployClientCertificate() {
    const certificate = {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: {
        name: this.clientCertName,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        commonName: `${this.prefix}-client`,
        usages: ['client auth'],
        secretName: this.clientSecretName,
        issuerRef: { name: this.caIssuerName, kind: 'Issuer' },
      },
    };
    await this.applyResource(certificate);

    if (!this.dryRun) {
      const ready = await CertificateHelper.waitForCertificate(
        this.namespace,
        this.clientCertName,
        CERT_READY_TIMEOUT_SECONDS
      );
      if (!ready) {
        throw new Error(`Certificate '${this.clientCertName}' did not become Ready in time`);
      }
    }
  }

  async cleanup() {
    this.log('Cleaning up frontend-mtls feature...', 'info');
    await this.deleteResource('Certificate', this.clientCertName, this.namespace);
    await this.deleteResource('Secret', this.clientSecretName, this.namespace);
    this.log('frontend-mtls feature cleaned up', 'success');
  }
}

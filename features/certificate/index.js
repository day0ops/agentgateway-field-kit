import { Feature } from '../../src/lib/feature.js';

/**
 * Certificate Feature
 *
 * Creates a cert-manager Certificate resource for TLS.
 *
 * Configuration:
 * {
 *   name: string,           // Certificate resource name (required)
 *   secretName: string,     // Secret name for TLS cert (required)
 *   issuer: string,         // ClusterIssuer name (default: selfsigned-issuer)
 *   dnsNames: string[],     // DNS names for the certificate (required)
 * }
 */
export class CertificateFeature extends Feature {
  get certName() {
    return this.config.name;
  }

  get secretName() {
    return this.config.secretName;
  }

  get issuer() {
    return this.config.issuer || 'selfsigned-issuer';
  }

  get dnsNames() {
    return this.config.dnsNames || [];
  }

  getFeaturePath() {
    return 'certificate';
  }

  validate() {
    if (!this.certName) {
      throw new Error('CertificateFeature requires name in config');
    }
    if (!this.secretName) {
      throw new Error('CertificateFeature requires secretName in config');
    }
    if (!this.dnsNames || this.dnsNames.length === 0) {
      throw new Error('CertificateFeature requires at least one dnsName in config');
    }
    return true;
  }

  async deploy() {
    this.log(`Creating certificate ${this.certName}...`, 'info');

    const overrides = {
      metadata: {
        name: this.certName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': 'certificate',
          'agentgateway.dev/certificate': this.certName,
        },
      },
      spec: {
        secretName: this.secretName,
        issuerRef: {
          name: this.issuer,
          kind: 'ClusterIssuer',
        },
        dnsNames: this.dnsNames,
      },
    };

    await this.applyYamlFile('certificate.yaml', overrides);
    this.log(`Certificate ${this.certName} created (secret: ${this.secretName})`, 'success');
  }

  async cleanup() {
    this.log(`Cleaning up certificate ${this.certName}...`, 'info');
    await this.deleteResource('Certificate', this.certName, this.namespace);
    // cert-manager doesn't delete the issued Secret when its Certificate is deleted.
    await this.deleteResource('Secret', this.secretName, this.namespace);
    this.log(`Certificate ${this.certName} cleaned up`, 'success');
  }
}

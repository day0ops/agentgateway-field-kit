import { Feature } from '../../src/lib/feature.js';
import { CertificateFeature } from '../certificate/index.js';
import { EDITION_BASE_NAME, BACKEND_API_GROUP, BACKEND_KIND } from '../../src/lib/editions.js';

const DEFAULT_HOSTNAMES = ['alpha.sni-demo.local', 'beta.sni-demo.local'];
const DEFAULT_UNMATCHED_HOSTNAME = 'gamma.sni-demo.local';

/**
 * SNI Matching Feature
 *
 * Deploys a dedicated Gateway (NOT the shared default Gateway - a full-manifest
 * apply would clobber its other listeners) with two hostname-scoped HTTPS
 * listeners, each presenting a different certificate selected by SNI. Routes
 * both hostnames to an existing backend (e.g. the mock-provider feature's), plus
 * a third HTTPRoute for a hostname with no matching listener/cert - proving TLS
 * rejects the connection by SNI before HTTP routing is ever considered.
 *
 * Configuration:
 * {
 *   name: string,               // Gateway/resource name prefix (default: 'agentgateway-sni')
 *   hostnames: [string, string],// The two SNI-matched hostnames (default: alpha/beta.sni-demo.local)
 *   unmatchedHostname: string,  // Third hostname with no listener/cert (default: gamma.sni-demo.local)
 *   backendRef: { name, namespace, group?, kind? }, // Backend both routes forward to
 *                               // (default: mock-provider's default backend name)
 * }
 */
export class SniMatchingFeature extends Feature {
  get prefix() {
    return this.config.name || 'agentgateway-sni';
  }

  get hostnames() {
    return this.config.hostnames || DEFAULT_HOSTNAMES;
  }

  get unmatchedHostname() {
    return this.config.unmatchedHostname || DEFAULT_UNMATCHED_HOSTNAME;
  }

  get backendRef() {
    return (
      this.config.backendRef || {
        name: 'mock-openai-backend',
        group: BACKEND_API_GROUP[this.edition],
        kind: BACKEND_KIND[this.edition],
      }
    );
  }

  get labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
    };
  }

  certSecretName(index) {
    return `${this.prefix}-cert-${index}`;
  }

  async deploy() {
    if (this.hostnames.length !== 2) {
      throw new Error('sni-matching requires exactly two hostnames in config.hostnames');
    }

    this.log('Deploying SNI-matched certificates...', 'info');
    await this.deployCertificate(0);
    await this.deployCertificate(1);

    this.log(`Deploying dedicated Gateway '${this.prefix}'...`, 'info');
    await this.deployGateway();

    this.log('Deploying SNI-matched HTTPRoutes...', 'info');
    await this.deployRoute('a', this.hostnames[0]);
    await this.deployRoute('b', this.hostnames[1]);
    await this.deployRoute('c', this.unmatchedHostname);

    this.log('SNI matching feature deployed', 'success');
  }

  async deployCertificate(index) {
    const cert = new CertificateFeature(this.name, {
      namespace: this.namespace,
      name: this.certSecretName(index),
      secretName: this.certSecretName(index),
      dnsNames: [this.hostnames[index]],
    });
    cert.setSpinner(this.spinner);
    cert.adoptParentContext(this);
    await cert.deploy();
  }

  async deployGateway() {
    const gateway = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'Gateway',
      metadata: {
        name: this.prefix,
        namespace: this.namespace,
        labels: { ...this.labels, app: this.prefix },
      },
      spec: {
        gatewayClassName: EDITION_BASE_NAME[this.edition],
        allowedListeners: { namespaces: { from: 'All' } },
        listeners: [0, 1].map(i => ({
          name: `https-${i === 0 ? 'a' : 'b'}`,
          port: 443,
          protocol: 'HTTPS',
          hostname: this.hostnames[i],
          tls: {
            mode: 'Terminate',
            certificateRefs: [{ name: this.certSecretName(i) }],
          },
          allowedRoutes: { namespaces: { from: 'All' } },
        })),
      },
    };
    await this.applyResource(gateway);
  }

  async deployRoute(suffix, hostname) {
    const route = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: `${this.prefix}-${suffix}`,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        hostnames: [hostname],
        parentRefs: [{ name: this.prefix, namespace: this.namespace }],
        rules: [{ backendRefs: [this.backendRef] }],
      },
    };
    await this.applyResource(route);
  }

  async cleanup() {
    this.log('Cleaning up sni-matching feature...', 'info');
    await this.deleteResource('HTTPRoute', `${this.prefix}-a`, this.namespace);
    await this.deleteResource('HTTPRoute', `${this.prefix}-b`, this.namespace);
    await this.deleteResource('HTTPRoute', `${this.prefix}-c`, this.namespace);
    await this.deleteResource('Gateway', this.prefix, this.namespace);
    await this.deleteResource('Certificate', this.certSecretName(0), this.namespace);
    await this.deleteResource('Certificate', this.certSecretName(1), this.namespace);
    await this.deleteResource('Secret', this.certSecretName(0), this.namespace);
    await this.deleteResource('Secret', this.certSecretName(1), this.namespace);
    this.log('sni-matching feature cleaned up', 'success');
  }
}

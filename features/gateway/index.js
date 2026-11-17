import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { EDITION_GATEWAY_NAME, EDITION_BASE_NAME } from '../../src/lib/editions.js';
import { KubernetesHelper, waitForPublicUrl, CertificateHelper } from '../../src/lib/common.js';

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Gateway Feature
 *
 * Overrides the default Gateway referenced by HTTPRoutes. Use this in a use case to:
 * - Use a different Gateway name or namespace
 * - Add or modify listeners (e.g. HTTP, HTTPS with TLS)
 * - Customize gatewayClassName or other spec fields
 *
 * When this feature is deployed, all HTTPRoutes created by other features in the same
 * use case will reference this Gateway via parentRefs.
 *
 * Configuration:
 * {
 *   name: string,             // Gateway resource name (default: EDITION_GATEWAY_NAME for this.edition)
 *   namespace: string,        // Optional; defaults to use case namespace
 *   gatewayClassName: string,
 *   listeners: [              // Gateway API listeners
 *     {
 *       name: string,         // Listener name (e.g. 'http', 'https')
 *       port: number,         // Port number
 *       protocol: string,     // 'HTTP' or 'HTTPS'
 *       tls?: {               // TLS config (required for HTTPS)
 *         mode: string,       // 'Terminate' or 'Passthrough'
 *         certificateRefs: [  // References to TLS secrets
 *           { name: string, namespace?: string }
 *         ]
 *       },
 *       allowedRoutes?: { namespaces: { from: string } }
 *     }
 *   ],
 *   tls: {                    // Passed through unchanged to spec.tls (Gateway API 1.5+,
 *                             // experimental channel - e.g. frontend client-cert
 *                             // validation: { frontend: { default: { validation: {...} } } })
 *     frontend?: object,
 *     backend?: object,
 *   },
 *   registerDns: boolean,     // Annotate the auto-provisioned Service for external-dns and
 *                             // wait indefinitely for the first listener's hostname to
 *                             // resolve with valid TLS before deploy() returns (default:
 *                             // false - most dedicated Gateways use a self-signed/
 *                             // cluster-internal hostname that was never meant to be
 *                             // externally resolvable)
 * }
 */
export class GatewayFeature extends Feature {
  getFeaturePath() {
    return this.name;
  }

  validate() {
    return true;
  }

  async deploy() {
    const {
      name = EDITION_GATEWAY_NAME[this.edition],
      namespace,
      gatewayClassName,
      listeners,
      tls,
      registerDns,
    } = this.config;

    const overrides = {
      metadata: {
        name,
        namespace: namespace ?? this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
          app: name,
        },
      },
    };

    const specOverrides = { gatewayClassName: gatewayClassName ?? EDITION_BASE_NAME[this.edition] };
    if (listeners !== undefined && listeners.length > 0) specOverrides.listeners = listeners;
    if (tls !== undefined) specOverrides.tls = tls;
    overrides.spec = specOverrides;

    await this.applyYamlFile('gateway.yaml', overrides);

    FeatureManager.setGatewayRef({
      name: overrides.metadata.name,
      namespace: overrides.metadata.namespace,
    });
    this.log(
      `Gateway '${overrides.metadata.name}' set as default for HTTPRoute parentRefs`,
      'info'
    );

    if (!this.dryRun) {
      const firstListener = specOverrides.listeners?.[0];
      const port = firstListener?.port ?? 8080;
      const protocol = firstListener?.protocol === 'HTTPS' ? 'https' : 'http';
      await this.waitForGatewayReachable(
        overrides.metadata.name,
        overrides.metadata.namespace,
        port,
        protocol
      );

      const hostname = firstListener?.hostname;
      if (registerDns && hostname && CertificateHelper.isExternalHostname(hostname)) {
        await this.registerExternalDns(
          overrides.metadata.name,
          overrides.metadata.namespace,
          hostname,
          port,
          protocol
        );
      }
    }
  }

  // Mirrors AgentGatewayManager's own install path for the shared Gateway: annotate the
  // auto-provisioned Service for external-dns, then wait for the hostname to resolve with
  // valid TLS. Opt-in (registerDns) since most dedicated Gateways use a self-signed/
  // cluster-internal hostname that was never meant to be externally resolvable.
  //
  // Waits indefinitely, unlike waitForGatewayReachable's own bounded wait below - DNS-01
  // issuance plus propagation for a brand new record has no reliable upper bound, and the
  // only consumers of this opt-in (the llm-gateway-* walkthroughs) would otherwise start a
  // demo against a Gateway that isn't actually reachable yet.
  async registerExternalDns(name, namespace, hostname, port, protocol) {
    try {
      await KubernetesHelper.kubectl([
        'annotate',
        'service',
        name,
        '-n',
        namespace,
        `external-dns.kubernetes.io/hostname=${hostname}`,
        '--overwrite',
      ]);
      this.log(`Annotated Service for DNS: ${hostname}`, 'info');
    } catch {
      this.log(
        'Could not annotate Service for external-dns - DNS record may not be created automatically',
        'warn'
      );
      return;
    }

    await waitForPublicUrl(hostname, {
      protocol,
      port,
      log: (msg, level) => this.log(msg, level),
    });
  }

  // The Gateway API controller auto-provisions a LoadBalancer Service named after the
  // Gateway. On AWS, that Service gets a fresh ELB hostname whose DNS record can take a
  // couple of minutes to propagate - a usecase's tests hitting it immediately after
  // deploy see "Could not resolve host" until it does. Cloud providers that hand out a
  // bare IP (GKE/AKS) don't need this: an IP resolves immediately, so this only waits on
  // hostnames.
  async waitForGatewayReachable(name, namespace, port, protocol = 'http') {
    this.log(`Waiting for Gateway '${name}' load balancer address...`, 'info');
    let address;
    try {
      address = await KubernetesHelper.getLoadBalancerAddress(namespace, name, 180);
    } catch (error) {
      this.log(`Gateway '${name}' load balancer not ready: ${error.message}`, 'warn');
      return;
    }

    if (IPV4_RE.test(address)) {
      return;
    }

    const timedOut = Symbol('timeout');
    const result = await Promise.race([
      waitForPublicUrl(address, {
        protocol,
        port,
        log: (msg, level) => this.log(msg, level),
      }),
      new Promise(resolve => setTimeout(() => resolve(timedOut), 5 * 60 * 1000)),
    ]);
    if (result === timedOut) {
      this.log(
        `Timed out waiting for DNS/${protocol.toUpperCase()} on '${address}' - it may still be propagating`,
        'warn'
      );
    }
  }

  async cleanup() {
    const { name = EDITION_GATEWAY_NAME[this.edition] } = this.config;
    await this.deleteResource('Gateway', name, this.namespace);
  }
}

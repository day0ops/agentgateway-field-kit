import { Feature } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';
import { BACKEND_API_GROUP, BACKEND_KIND } from '../../src/lib/editions.js';

const DEFAULT_PROXY_NAMESPACE = 'corporate-proxy';
const DEFAULT_PORT = 3128;

/**
 * Corporate Proxy Feature
 *
 * Deploys a Squid forward proxy (Deployment/Service/ConfigMap) to simulate an
 * enterprise egress point, plus an Backend (EnterpriseAgentgatewayBackend/AgentgatewayBackend,
 * per edition) that represents it so other backends can route outbound connections
 * through it via `policies.tunnel.backendRef` (e.g. JWKS fetching from behind a corporate
 * network - see https://docs.solo.io/agentgateway/latest/llm/providers/backend-tunnel-proxy/).
 *
 * The Squid workload lives in its own namespace (proxyNamespace) to mirror a
 * real corporate egress deployment; the Backend representing it
 * is created in the gateway namespace so same-namespace tunnel.backendRef
 * lookups from other backends (e.g. okta-jwks, entra-jwks) resolve without
 * needing an explicit namespace field.
 *
 * Configuration:
 * {
 *   name: string,            // Deployment/Service/ConfigMap/backend name (default: 'corporate-proxy')
 *   proxyNamespace: string,  // Namespace for the Squid workload (default: 'corporate-proxy')
 *   image: string,           // Squid container image (default: ubuntu/squid:latest)
 *   port: number,            // Squid listen port (default: 3128)
 *   allowedHosts: string[],  // Squid dstdomain allowlist; omit/empty = allow all destinations
 * }
 */
export class CorporateProxyFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.appName = config.name || 'corporate-proxy';
    this.proxyNamespace = config.proxyNamespace || DEFAULT_PROXY_NAMESPACE;
    this.image = config.image || 'ubuntu/squid:latest';
    this.port = config.port || DEFAULT_PORT;
    this.allowedHosts = config.allowedHosts || [];
  }

  get labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
    };
  }

  get serviceHost() {
    return `${this.appName}.${this.proxyNamespace}.svc.cluster.local`;
  }

  get squidConf() {
    const lines = [
      'http_port ' + this.port,
      'acl SSL_ports port 443',
      'acl CONNECT method CONNECT',
    ];

    if (this.allowedHosts.length > 0) {
      lines.push(`acl allowed_dsts dstdomain ${this.allowedHosts.join(' ')}`);
      lines.push('http_access allow CONNECT SSL_ports allowed_dsts');
      lines.push('http_access deny CONNECT !SSL_ports');
      lines.push('http_access allow allowed_dsts');
      lines.push('http_access deny all');
    } else {
      lines.push('http_access allow CONNECT SSL_ports');
      lines.push('http_access deny CONNECT !SSL_ports');
      lines.push('http_access allow all');
    }

    lines.push('access_log stdio:/var/log/squid/access.log combined');
    lines.push('cache deny all');
    return lines.join('\n') + '\n';
  }

  async deploy() {
    if (!this.dryRun) {
      await KubernetesHelper.ensureNamespace(this.proxyNamespace, this.spinner);
    }
    await this.deployConfig();
    await this.deployWorkload();
    await this.deployBackend();
  }

  async deployConfig() {
    const configMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: this.appName,
        namespace: this.proxyNamespace,
        labels: this.labels,
      },
      data: { 'squid.conf': this.squidConf },
    };
    await this.applyResource(configMap);
  }

  async deployWorkload() {
    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: this.appName,
        namespace: this.proxyNamespace,
        labels: { ...this.labels, app: this.appName },
      },
      spec: {
        selector: { app: this.appName },
        ports: [{ port: this.port, targetPort: this.port, name: 'squid' }],
        type: 'ClusterIP',
      },
    };
    await this.applyResource(service);

    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: this.appName,
        namespace: this.proxyNamespace,
        labels: { ...this.labels, app: this.appName },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: this.appName } },
        template: {
          metadata: { labels: { app: this.appName } },
          spec: {
            containers: [
              {
                name: 'squid',
                image: this.image,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ containerPort: this.port, name: 'squid' }],
                volumeMounts: [
                  {
                    name: 'squid-conf',
                    mountPath: '/etc/squid/squid.conf',
                    subPath: 'squid.conf',
                  },
                ],
              },
            ],
            volumes: [{ name: 'squid-conf', configMap: { name: this.appName } }],
          },
        },
      },
    };
    await this.applyResource(deployment);
    this.log(
      `Squid corporate proxy '${this.appName}' deployed in namespace '${this.proxyNamespace}' on port ${this.port}`,
      'info'
    );
  }

  async deployBackend() {
    const backend = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: this.appName,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        static: {
          host: this.serviceHost,
          port: this.port,
        },
      },
    };
    await this.applyResource(backend);
    this.log(
      `${BACKEND_KIND[this.edition]} '${this.appName}' created in '${this.namespace}' for policies.tunnel.backendRef`,
      'info'
    );
  }

  async cleanup() {
    this.log('Cleaning up corporate-proxy feature...', 'info');
    await this.deleteResource(BACKEND_KIND[this.edition], this.appName, this.namespace);
    await this.deleteResource('Deployment', this.appName, this.proxyNamespace);
    await this.deleteResource('Service', this.appName, this.proxyNamespace);
    await this.deleteResource('ConfigMap', this.appName, this.proxyNamespace);
    this.log('corporate-proxy feature cleaned up', 'success');
  }
}

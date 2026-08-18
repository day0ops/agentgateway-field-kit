import { spawn } from 'child_process';
import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { CommandRunner, KubernetesHelper } from '../../src/lib/common.js';
import { EDITION_GATEWAY_NAME } from '../../src/lib/editions.js';

/**
 * Workload Agent Feature
 *
 * Deploys any autonomous workload agent as a Kubernetes Deployment with
 * ServiceAccount, Service, and HTTPRoute. Handles Keycloak client secret
 * injection and optional SA token projection for Phase 2 token exchange.
 *
 * Used for both the caller-agent (calls stock-agent via AGW) and the
 * stock-agent in the workload-identity-chain use case (calls MCP as its
 * own identity with MCP_AUTH_MODE=workload).
 *
 * Configuration:
 * {
 *   agentName: string,           // Default: 'caller-agent'
 *   image: string,               // Default: GAR caller-agent:0.1.1
 *   imagePullPolicy: string,     // Default: 'IfNotPresent'
 *   pathPrefix: string,          // Default: '/caller-agent'
 *   routeName: string,           // Default: agentName
 *   port: number,                // Default: 8080
 *   keycloakUrl: string,         // Default: http://keycloak.keycloak.svc.cluster.local:8080
 *   keycloakRealm: string,       // Default: 'agw-dev'
 *   clientId: string,            // Default: 'caller-agent'
 *   clientSecretName: string,    // K8s Secret name with 'client_secret' key (default: 'caller-agent-credentials')
 *   audience: string,            // Default: 'agentgateway'
 *   stockAgentUrl: string,       // STOCK_AGENT_URL env var (default: http://<edition gateway service>.<ns>.svc.cluster.local:8080/agent/run)
 *   llmBaseUrl: string,          // LLM_BASE_URL env var — for agents that need an LLM endpoint (optional)
 *   mcpUrl: string,              // MCP_URL env var — for agents that call MCP directly (optional)
 *   model: string,               // MODEL env var (optional)
 *   mcpAuthMode: string,         // MCP_AUTH_MODE env var: 'propagate' or 'workload' (optional)
 *   additionalEnv: [{name, value}], // Extra env vars merged into the deployment (optional)
 *   useTokenExchange: bool,      // Phase 2: mount SA token + set USE_KEYCLOAK_EXCHANGE=true (default: false)
 *   saTokenAudience: string,     // Audience for the projected SA token (default: 'agentgateway')
 *   saTokenPath: string,         // Mount path inside container (default: /var/run/secrets/tokens/sa-token)
 *   mayActClaim: bool,           // Add oidc-hardcoded-claim-mapper for may_act to KC client at deploy time (default: false)
 *                                // Requires KEYCLOAK_ADMIN_USERNAME / KEYCLOAK_ADMIN_PASSWORD env vars when enabled.
 * }
 */
export class WorkloadAgentFeature extends Feature {
  constructor(name, config) {
    super(name, config);

    const ns = this.namespace;
    this.agentName = config.agentName || 'caller-agent';
    this.image =
      config.image ||
      'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/caller-agent:0.1.1';
    this.imagePullPolicy = config.imagePullPolicy || 'IfNotPresent';
    this.pathPrefix = config.pathPrefix || '/caller-agent';
    this.routeName = config.routeName || this.agentName;
    this.port = config.port ?? 8080;

    this.keycloakUrl = WorkloadAgentFeature.normalizeKeycloakUrl(
      config.keycloakUrl || 'http://keycloak.keycloak.svc.cluster.local:8080'
    );
    this.keycloakRealm = config.keycloakRealm || 'agw-dev';
    this.clientId = config.clientId || 'caller-agent';
    this.clientSecretName = config.clientSecretName || 'caller-agent-credentials';
    this.audience = config.audience || 'agentgateway';
    this.stockAgentUrl =
      config.stockAgentUrl ||
      `http://${EDITION_GATEWAY_NAME[this.edition]}.${ns}.svc.cluster.local:8080/agent/run`;

    this.llmBaseUrl = config.llmBaseUrl || null;
    this.mcpUrl = config.mcpUrl || null;
    this.model = config.model || null;
    this.mcpAuthMode = config.mcpAuthMode || null;
    this.additionalEnv = Array.isArray(config.additionalEnv) ? config.additionalEnv : [];

    this.useTokenExchange = config.useTokenExchange || false;
    this.saTokenAudience = config.saTokenAudience || 'agentgateway';
    this.saTokenPath = config.saTokenPath || '/var/run/secrets/tokens/sa-token';

    this.mayActClaim = config.mayActClaim || false;
    this.keycloakAdminUser = process.env.KEYCLOAK_ADMIN_USERNAME || '';
    this.keycloakAdminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD || '';
  }

  /**
   * Ensure keycloakUrl has a scheme (and port for cluster-local).
   * Handles bare hostnames from env templates like {{env.domains.keycloak}}.
   */
  static normalizeKeycloakUrl(url) {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = url.includes('.svc.cluster.local') ? `http://${url}` : `https://${url}`;
    }
    try {
      const parsed = new URL(url);
      if (!parsed.port && parsed.hostname.includes('.svc.cluster.local')) {
        return `${url}:8080`;
      }
    } catch {
      // malformed — return as-is
    }
    return url;
  }

  getFeaturePath() {
    return 'workload-agent';
  }

  validate() {
    return true;
  }

  async deploy() {
    this.log(`Deploying workload agent '${this.agentName}'...`, 'info');

    await this.deployServiceAccount();
    await this.deployDeployment();
    await this.deployService();
    await this.deployHTTPRoute();

    if (!this.dryRun) {
      await this.waitForReady();
      if (this.mayActClaim) {
        await this.addMayActToKcClient();
      }
    }

    this.log(`Workload agent '${this.agentName}' deployed`, 'success');
  }

  async deployServiceAccount() {
    await this.applyResource({
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: {
        name: this.agentName,
        namespace: this.namespace,
        labels: this.commonLabels(),
      },
    });
  }

  async deployDeployment() {
    const env = [
      { name: 'KEYCLOAK_URL', value: this.keycloakUrl },
      { name: 'KEYCLOAK_REALM', value: this.keycloakRealm },
      { name: 'CLIENT_ID', value: this.clientId },
      {
        name: 'CLIENT_SECRET',
        valueFrom: {
          secretKeyRef: {
            name: this.clientSecretName,
            key: 'client_secret',
            optional: true,
          },
        },
      },
      { name: 'AUDIENCE', value: this.audience },
      { name: 'STOCK_AGENT_URL', value: this.stockAgentUrl },
      { name: 'USE_KEYCLOAK_EXCHANGE', value: String(this.useTokenExchange) },
      ...(this.llmBaseUrl ? [{ name: 'LLM_BASE_URL', value: this.llmBaseUrl }] : []),
      ...(this.mcpUrl ? [{ name: 'MCP_URL', value: this.mcpUrl }] : []),
      ...(this.model ? [{ name: 'MODEL', value: this.model }] : []),
      ...(this.mcpAuthMode ? [{ name: 'MCP_AUTH_MODE', value: this.mcpAuthMode }] : []),
      ...this.additionalEnv,
    ];

    const volumeMounts = [];
    const volumes = [];

    if (this.useTokenExchange) {
      env.push({ name: 'SA_TOKEN_PATH', value: this.saTokenPath });
      volumeMounts.push({
        name: 'sa-token',
        mountPath: this.saTokenPath.replace(/\/[^/]+$/, ''),
        readOnly: true,
      });
      volumes.push({
        name: 'sa-token',
        projected: {
          sources: [
            {
              serviceAccountToken: {
                path: 'sa-token',
                expirationSeconds: 3600,
                audience: this.saTokenAudience,
              },
            },
          ],
        },
      });
    }

    await this.applyResource({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: this.agentName,
        namespace: this.namespace,
        labels: this.commonLabels(),
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: this.agentName } },
        template: {
          metadata: { labels: { app: this.agentName } },
          spec: {
            serviceAccountName: this.agentName,
            containers: [
              {
                name: 'agent',
                image: this.image,
                imagePullPolicy: this.imagePullPolicy,
                ports: [{ containerPort: this.port }],
                env,
                resources: {
                  requests: { memory: '256Mi', cpu: '100m' },
                  limits: { memory: '512Mi', cpu: '500m' },
                },
                readinessProbe: {
                  httpGet: { path: '/health', port: this.port },
                  initialDelaySeconds: 10,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: '/health', port: this.port },
                  initialDelaySeconds: 20,
                  periodSeconds: 30,
                },
                ...(volumeMounts.length ? { volumeMounts } : {}),
              },
            ],
            ...(volumes.length ? { volumes } : {}),
          },
        },
      },
    });
    this.log(`Deployment '${this.agentName}' created`, 'info');
  }

  async deployService() {
    await this.applyResource({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: this.agentName,
        namespace: this.namespace,
        labels: this.commonLabels(),
      },
      spec: {
        selector: { app: this.agentName },
        ports: [{ port: this.port, targetPort: this.port }],
        type: 'ClusterIP',
      },
    });
  }

  async deployHTTPRoute() {
    const gatewayRef = FeatureManager.getGatewayRef();
    await this.applyResource({
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: this.commonLabels(),
      },
      spec: {
        parentRefs: [{ name: gatewayRef.name, namespace: gatewayRef.namespace || this.namespace }],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: this.pathPrefix } }],
            filters: [
              {
                type: 'URLRewrite',
                urlRewrite: {
                  path: { type: 'ReplacePrefixMatch', replacePrefixMatch: '/' },
                },
              },
            ],
            backendRefs: [{ name: this.agentName, namespace: this.namespace, port: this.port }],
          },
        ],
      },
    });
    this.log(`HTTPRoute '${this.routeName}' at ${this.pathPrefix}`, 'info');
  }

  async waitForReady() {
    this.log(`Waiting for '${this.agentName}' to be ready...`, 'info');
    try {
      await KubernetesHelper.kubectl([
        'rollout',
        'status',
        `deployment/${this.agentName}`,
        '-n',
        this.namespace,
        '--timeout=120s',
      ]);
    } catch {
      this.log(`${this.agentName} rollout timed out (may still be pulling image)`, 'warn');
    }
  }

  /**
   * Runs fn(baseUrl, adminToken) against the Keycloak admin API.
   * If keycloakUrl is cluster-local (.svc.cluster.local) a kubectl port-forward
   * is set up first; otherwise the URL is used directly.
   */
  async withKcAdminApi(fn) {
    let parsedUrl;
    try {
      parsedUrl = new URL(this.keycloakUrl);
    } catch {
      parsedUrl = new URL('http://keycloak.keycloak.svc.cluster.local:8080');
    }

    const isClusterLocal = parsedUrl.hostname.includes('.svc.cluster.local');
    let baseUrl;
    let pfProc = null;

    if (isClusterLocal) {
      const hostParts = parsedUrl.hostname.split('.');
      const kcServiceName = hostParts[0] || 'keycloak';
      const kcServiceNamespace = hostParts[1] || 'keycloak';
      const kcPort = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 8080;
      const localPort = 17778;

      pfProc = spawn(
        'kubectl',
        [
          'port-forward',
          '-n',
          kcServiceNamespace,
          `svc/${kcServiceName}`,
          `${localPort}:${kcPort}`,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      );

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('kubectl port-forward timed out after 15s')),
          15000
        );
        pfProc.stdout.on('data', chunk => {
          if (chunk.toString().includes('Forwarding from')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        pfProc.on('exit', code => {
          clearTimeout(timeout);
          if (code !== null) reject(new Error(`kubectl port-forward exited with code ${code}`));
        });
      });
      baseUrl = `http://localhost:${localPort}`;
    } else {
      baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
    }

    try {
      const tokenRes = await CommandRunner.run('curl', [
        '-sf',
        '-X',
        'POST',
        `${baseUrl}/realms/master/protocol/openid-connect/token`,
        '-d',
        `client_id=admin-cli&grant_type=password&username=${encodeURIComponent(this.keycloakAdminUser)}&password=${encodeURIComponent(this.keycloakAdminPassword)}`,
      ]);
      const tokenData = JSON.parse(tokenRes.stdout);
      const adminToken = tokenData.access_token;
      if (!adminToken) throw new Error('Failed to get KC admin token');

      return await fn(baseUrl, adminToken);
    } finally {
      if (pfProc) pfProc.kill();
    }
  }

  async addMayActToKcClient() {
    this.log(`Adding may_act claim mapper to KC client '${this.clientId}'...`, 'info');

    await this.withKcAdminApi(async (baseUrl, adminToken) => {
      const clientsRes = await CommandRunner.run('curl', [
        '-sf',
        '-H',
        `Authorization: Bearer ${adminToken}`,
        `${baseUrl}/admin/realms/${this.keycloakRealm}/clients?clientId=${encodeURIComponent(this.clientId)}`,
      ]);
      const clients = JSON.parse(clientsRes.stdout);
      if (!clients.length)
        throw new Error(`KC client '${this.clientId}' not found in realm '${this.keycloakRealm}'`);
      const clientInternalId = clients[0].id;

      const mappersRes = await CommandRunner.run('curl', [
        '-sf',
        '-H',
        `Authorization: Bearer ${adminToken}`,
        `${baseUrl}/admin/realms/${this.keycloakRealm}/clients/${clientInternalId}/protocol-mappers/models`,
      ]);
      const mappers = JSON.parse(mappersRes.stdout);
      const mapperName = `may-act-${this.agentName}`;
      if (mappers.some(m => m.name === mapperName)) {
        this.log(`may_act mapper '${mapperName}' already exists, skipping`, 'info');
        return;
      }

      const mayActValue = JSON.stringify({
        sub: `system:serviceaccount:${this.namespace}:${this.agentName}`,
      });
      const mapperBody = JSON.stringify({
        name: mapperName,
        protocol: 'openid-connect',
        protocolMapper: 'oidc-hardcoded-claim-mapper',
        config: {
          'claim.name': 'may_act',
          'claim.value': mayActValue,
          'jsonType.label': 'JSON',
          'access.token.claim': 'true',
          'id.token.claim': 'false',
          'userinfo.token.claim': 'false',
        },
      });

      await CommandRunner.run('curl', [
        '-sf',
        '-X',
        'POST',
        '-H',
        `Authorization: Bearer ${adminToken}`,
        '-H',
        'Content-Type: application/json',
        '-d',
        mapperBody,
        `${baseUrl}/admin/realms/${this.keycloakRealm}/clients/${clientInternalId}/protocol-mappers/models`,
      ]);
    });

    this.log(`may_act claim mapper added to KC client '${this.clientId}'`, 'success');
  }

  async removeMayActFromKcClient() {
    this.log(`Removing may_act claim mapper from KC client '${this.clientId}'...`, 'info');

    try {
      await this.withKcAdminApi(async (baseUrl, adminToken) => {
        const clientsRes = await CommandRunner.run('curl', [
          '-sf',
          '-H',
          `Authorization: Bearer ${adminToken}`,
          `${baseUrl}/admin/realms/${this.keycloakRealm}/clients?clientId=${encodeURIComponent(this.clientId)}`,
        ]);
        const clients = JSON.parse(clientsRes.stdout);
        if (!clients.length) {
          this.log(`KC client '${this.clientId}' not found, skipping mapper removal`, 'warn');
          return;
        }
        const clientInternalId = clients[0].id;

        const mappersRes = await CommandRunner.run('curl', [
          '-sf',
          '-H',
          `Authorization: Bearer ${adminToken}`,
          `${baseUrl}/admin/realms/${this.keycloakRealm}/clients/${clientInternalId}/protocol-mappers/models`,
        ]);
        const mappers = JSON.parse(mappersRes.stdout);
        const mapperName = `may-act-${this.agentName}`;
        const mapper = mappers.find(m => m.name === mapperName);
        if (!mapper) {
          this.log(`may_act mapper '${mapperName}' not found, skipping`, 'info');
          return;
        }

        await CommandRunner.run('curl', [
          '-sf',
          '-X',
          'DELETE',
          '-H',
          `Authorization: Bearer ${adminToken}`,
          `${baseUrl}/admin/realms/${this.keycloakRealm}/clients/${clientInternalId}/protocol-mappers/models/${mapper.id}`,
        ]);
      });

      this.log(`may_act claim mapper removed from KC client '${this.clientId}'`, 'success');
    } catch (err) {
      this.log(`Failed to remove may_act mapper: ${err.message}`, 'warn');
    }
  }

  commonLabels() {
    return {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
      app: this.agentName,
    };
  }

  async cleanup() {
    this.log(`Cleaning up workload agent '${this.agentName}'...`, 'info');

    if (this.mayActClaim) {
      await this.removeMayActFromKcClient();
    }

    await this.deleteResource('HTTPRoute', this.routeName);
    await this.deleteResource('Deployment', this.agentName);
    await this.deleteResource('Service', this.agentName);
    await this.deleteResource('ServiceAccount', this.agentName);

    this.log(`Workload agent '${this.agentName}' cleaned up`, 'success');
  }
}

import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';
import fs from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_KEYCLOAK_REALM = 'agw-dev';
const DEFAULT_KEYCLOAK_HOST = 'keycloak.keycloak.svc.cluster.local';
const DEFAULT_TLS_SECRET_NAME = 'quota-management-tls-secret';
const DEFAULT_TLS_HOSTNAME = 'localhost';
const DEFAULT_POSTGRES_TLS_SECRET_NAME = 'quota-management-postgres-tls';
const POSTGRES_SERVER_CERT_NAME = 'quota-management-postgres-server';

/**
 * Quota Budget Feature
 *
 * @deprecated Replaced by the native 'budget-limits' feature (EnterpriseAgentgatewayBudget CRD).
 * No custom ext-proc/Postgres infrastructure required. See features/budget-limits/index.js.
 *
 * Implements cost-based budget limiting for LLM requests using an ext-proc server.
 * Runs at PostRouting phase to track actual token usage and enforce budgets.
 *
 * Configuration:
 * {
 *   extprocImage: string,       // Extproc container image (default: GAR quota-budget-extproc:0.1.0)
 *   uiImage: string,            // UI container image (default: GAR quota-management-ui:0.1.0)
 *   deployInfra: boolean,       // Deploy PostgreSQL and quota-management service (default: true)
 *   enableTls: boolean,         // Enable TLS for PostgreSQL connections (default: false)
 *   enableUIAuth: boolean,      // Enable Keycloak OAuth for UI (default: false)
 *   keycloakRealm: string,      // Keycloak realm (default: 'agw-dev')
 *   keycloakHost: string,       // Keycloak service host (default: 'keycloak.keycloak.svc.cluster.local')
 *   hostname: string,           // UI hostname for TLS and OAuth redirect (default: 'localhost')
 *   port: number,               // HTTPS port for UI (default: 8443)
 *   budgetConfig: object        // Budget creation config { type: 'org'|'team'|'user', budgets: [...] }
 * }
 */
export class QuotaBudgetFeature extends Feature {
  // Enterprise-only quota/budget management, confirmed no reusable OSS primitive exists.
  static SUPPORTED_EDITIONS = ['enterprise'];
  static DEPRECATED = {
    replacedBy: 'budget-limits',
    reason:
      'Replaced by the native EnterpriseAgentgatewayBudget CRD - no custom ext-proc/Postgres required.',
  };

  get extprocServiceName() {
    return 'quota-budget-extproc';
  }

  get keycloakRealm() {
    return this.config.keycloakRealm || DEFAULT_KEYCLOAK_REALM;
  }

  get keycloakHost() {
    return this.config.keycloakHost || DEFAULT_KEYCLOAK_HOST;
  }

  get tlsSecretName() {
    return this.config.tlsSecretName || DEFAULT_TLS_SECRET_NAME;
  }

  get hostname() {
    return this.config.hostname || this.config.tls?.hostname || DEFAULT_TLS_HOSTNAME;
  }

  get port() {
    return this.config.port || 443;
  }

  get tlsIssuer() {
    return this.config.tls?.issuer || 'selfsigned-issuer';
  }

  async deploy() {
    const deployInfra = this.config.deployInfra !== false;

    if (deployInfra) {
      await this.deployPostgres();
    }

    await this.deployBudgetExtproc();

    const providerRoutes = this.config.providerRoutes || [];
    await this.applyExtProcPolicy(providerRoutes);

    if (deployInfra && this.config.enableUIAuth) {
      await this.setupAuthForUI();
    }

    if (deployInfra && (this.config.enableTls || this.config.enableUIAuth)) {
      await this.setupTlsForUI();
    }

    await this.deployPodMonitor();

    if (this.config.budgetConfig) {
      await this.createBudgets(this.config.budgetConfig);
    }
  }

  async deployPostgres() {
    if (this.config.enableTls) {
      await this.applyYamlFile('certificate.yaml', {
        metadata: {
          name: POSTGRES_SERVER_CERT_NAME,
        },
        spec: {
          secretName: DEFAULT_POSTGRES_TLS_SECRET_NAME,
        },
      });

      const postgresDeploymentYaml = await this._readPatchAndFormatPostgresYaml();
      await KubernetesHelper.applyYaml(postgresDeploymentYaml);
    } else {
      const postgresYaml = await fs.readFile(join(__dirname, 'config', 'postgres.yaml'), 'utf8');
      await KubernetesHelper.applyYaml(postgresYaml);
    }

    this.log('Waiting for PostgreSQL to be ready...');
    try {
      await KubernetesHelper.kubectl([
        'wait',
        '--for=condition=ready',
        'pod',
        '-l',
        'app=quota-management-postgres',
        '-n',
        this.namespace,
        '--timeout=120s',
      ]);
    } catch (_error) {
      this.log('PostgreSQL not ready yet, continuing...', 'warn');
    }

    this.log('PostgreSQL deployed');
  }

  async deployBudgetExtproc() {
    const deploymentYaml = await this._readPatchAndFormatDeploymentYaml();
    await KubernetesHelper.applyYaml(deploymentYaml);
    this.log('Budget ext-proc deployed');
  }

  async applyExtProcPolicy(providerRoutes) {
    if (providerRoutes.length === 0) {
      this.log('No provider routes specified, skipping ext-proc policy', 'warn');
      return;
    }
    for (const route of providerRoutes) {
      const routeName = typeof route === 'string' ? route : route.name;
      await this.applyYamlFile('ext-proc-policy.yaml', {
        metadata: {
          name: `quota-budget-${routeName}`,
        },
        spec: {
          targetRefs: [
            {
              group: 'gateway.networking.k8s.io',
              kind: 'HTTPRoute',
              name: routeName,
            },
          ],
        },
      });
    }
    this.log('Ext-proc policy applied for budget enforcement');
  }

  async setupAuthForUI() {
    const keycloakUrl = `https://${this.keycloakHost}/realms/${this.keycloakRealm}/`;
    const appUrl = this.config.auth?.appUrl || `https://${this.hostname}:${this.port}`;

    await this.applyYamlFile('oauth-secret.yaml');
    await this.applyYamlFile('access-policy.yaml');
    await this.applyYamlFile('auth-config.yaml', {
      spec: {
        configs: [
          {
            oauth2: {
              oidcAuthorizationCode: {
                appUrl,
                callbackPath: '/ui/callback',
                logoutPath: '/logout',
                clientId: 'quota-management',
                clientSecretRef: {
                  name: 'quota-management-oauth',
                  namespace: this.namespace,
                },
                issuerUrl: keycloakUrl,
                scopes: ['openid', 'email', 'profile', 'offline_access'],
                session: {
                  failOnFetchFailure: true,
                  redis: {
                    cookieName: 'budget-session',
                    allowRefreshing: true,
                    options: {
                      host: 'ext-cache-enterprise-agentgateway:6379',
                    },
                  },
                  refresh: {
                    validFor: '24h',
                  },
                },
                headers: {
                  idTokenHeader: 'jwt',
                },
              },
            },
          },
          {
            opaAuth: {
              modules: [{ name: 'quota-management-access-policy', namespace: this.namespace }],
              query: 'data.quota.allow == true',
            },
          },
        ],
      },
    });

    await this.applyYamlFile('auth-policy.yaml');

    this.log('OAuth authentication configured for UI');
  }

  async setupTlsForUI() {
    const isAcme = this.tlsIssuer !== 'selfsigned-issuer';
    const dnsNames = [this.hostname];
    if (!isAcme) {
      dnsNames.push('quota-management.agentgateway-system.svc.cluster.local');
    }

    await this.applyYamlFile('certificate.yaml', {
      spec: {
        secretName: this.tlsSecretName,
        issuerRef: { name: this.tlsIssuer, kind: 'ClusterIssuer' },
        dnsNames,
      },
    });

    await this.applyYamlFile('https-gateway.yaml', {
      spec: {
        listeners: [
          {
            name: 'https',
            port: this.port,
            protocol: 'HTTPS',
            hostname: this.hostname,
            tls: {
              mode: 'Terminate',
              certificateRefs: [{ name: this.tlsSecretName, kind: 'Secret' }],
            },
            allowedRoutes: { namespaces: { from: 'All' } },
          },
        ],
      },
    });

    const httprouteYaml = await fs.readFile(join(__dirname, 'config', 'httproute.yaml'), 'utf8');
    const httprouteDocs = yaml.loadAll(httprouteYaml).filter(Boolean);
    const corsFilter = this.config.enableCORS
      ? {
          type: 'CORS',
          cors: {
            allowOrigins: this.config.cors?.allowOrigins || ['*'],
            allowMethods: this.config.cors?.allowMethods || ['GET', 'POST', 'OPTIONS'],
            allowHeaders: this.config.cors?.allowHeaders || [
              'Origin',
              'Authorization',
              'Content-Type',
            ],
            exposeHeaders: this.config.cors?.exposeHeaders || ['Origin', 'X-HTTPRoute-Header'],
            maxAge: this.config.cors?.maxAge || 86400,
          },
        }
      : null;

    for (const doc of httprouteDocs) {
      if (doc.kind === 'HTTPRoute') {
        doc.spec.hostnames = [this.hostname];
        if (corsFilter && doc.metadata.name === 'quota-management-public') {
          const credFilter = {
            ...corsFilter,
            cors: { ...corsFilter.cors, allowCredentials: true },
          };
          for (const rule of doc.spec.rules || []) {
            const isOptions = rule.matches?.some(m => m.method === 'OPTIONS');
            rule.filters = [isOptions ? credFilter : corsFilter];
          }
        }
        if (corsFilter && doc.metadata.name === 'quota-management-ui') {
          const uiCorsFilter = {
            ...corsFilter,
            cors: { ...corsFilter.cors, allowCredentials: true },
          };
          for (const rule of doc.spec.rules || []) {
            rule.filters = [uiCorsFilter];
          }
        }
      }
    }
    const patchedHttprouteYaml = httprouteDocs
      .map(doc => yaml.dump(doc, { lineWidth: -1, noRefs: true }))
      .join('---\n');
    await KubernetesHelper.applyYaml(patchedHttprouteYaml);

    await this.applyYamlFile('tracing-suppress-policy.yaml');

    this.log('TLS configured for UI');
  }

  async deployPodMonitor() {
    try {
      const result = await KubernetesHelper.kubectl(
        ['get', 'crd', 'podmonitors.monitoring.coreos.com'],
        { ignoreError: true }
      );
      if (result.exitCode !== 0) {
        this.log('PodMonitor CRD not found, skipping', 'info');
        return;
      }
      await this.applyYamlFile('pod-monitor.yaml');
      this.log('PodMonitor deployed for quota-budget metrics');
    } catch (error) {
      this.log(`Failed to deploy PodMonitor: ${error.message}`, 'warn');
    }
  }

  async createBudgets(budgetConfig) {
    const { type, budgets } = budgetConfig;

    if (!type || !budgets || !Array.isArray(budgets)) {
      this.log('Invalid budget config: must specify type and budgets array', 'warn');
      return;
    }

    this.log(`Creating ${budgets.length} ${type} budgets...`);

    for (const budget of budgets) {
      try {
        await this._createBudget(type, budget);
        this.log(`Created budget: ${budget.name}`);
      } catch (error) {
        this.log(`Failed to create budget ${budget.name}: ${error.message}`, 'warn');
      }
    }
  }

  async _createBudget(entityType, budget) {
    const budgetDefinition = {
      entity_type: entityType,
      name: budget.name,
      match_expression: budget.matchExpression,
      budget_amount_usd: budget.amount,
      period: budget.period || 'monthly',
      warning_threshold_pct: budget.warningThreshold || 80,
      enabled: budget.enabled !== false,
      description: budget.description || '',
    };

    if (budget.customPeriodSeconds) {
      budgetDefinition.custom_period_seconds = budget.customPeriodSeconds;
    }

    const podName = await this._getPostgresPodName();
    const insertSql = this._buildInsertSql(budgetDefinition);

    await KubernetesHelper.kubectl([
      'exec',
      '-n',
      this.namespace,
      podName,
      '--',
      'psql',
      '-U',
      'budget',
      '-d',
      'budget_management',
      '-c',
      insertSql,
    ]);
  }

  _buildInsertSql(budget) {
    const fields = Object.keys(budget).join(', ');
    const values = Object.values(budget)
      .map(v => {
        if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        return v;
      })
      .join(', ');

    return `INSERT INTO budget_definitions (${fields}) VALUES (${values}) ON CONFLICT (entity_type, name) DO NOTHING;`;
  }

  async _getPostgresPodName() {
    const result = await KubernetesHelper.kubectl([
      'get',
      'pods',
      '-n',
      this.namespace,
      '-l',
      'app=quota-management-postgres',
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ]);
    return result.stdout.trim();
  }

  async _readPatchAndFormatDeploymentYaml() {
    const extprocImage =
      this.config.extprocImage ||
      'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/quota-budget-extproc:0.1.0';
    const uiImage =
      this.config.uiImage ||
      'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/quota-management-ui:0.1.0';

    let deploymentYaml = await fs.readFile(join(__dirname, 'config', 'deployment.yaml'), 'utf8');

    deploymentYaml = deploymentYaml.replace(
      /image: quota-budget-extproc:latest/g,
      `image: ${extprocImage}`
    );
    deploymentYaml = deploymentYaml.replace(
      /image: quota-management-ui:latest/g,
      `image: ${uiImage}`
    );

    if (this.config.enableTls) {
      deploymentYaml = await this._patchBudgetDeploymentDocumentsForTls(deploymentYaml);
    }

    return deploymentYaml;
  }

  async _patchBudgetDeploymentDocumentsForTls(deploymentYaml) {
    const documents = yaml.loadAll(deploymentYaml).filter(Boolean);

    for (const doc of documents) {
      if (doc.kind === 'Deployment' && doc.metadata.name === 'quota-budget-extproc') {
        const container = doc.spec.template.spec.containers[0];
        const dbUrl = `postgres://budget:budget@quota-management-postgres:5432/budget_management?sslmode=require`;

        const dbUrlEnv = container.env.find(e => e.name === 'DATABASE_URL');
        if (dbUrlEnv) {
          dbUrlEnv.value = dbUrl;
        }

        container.volumeMounts = container.volumeMounts || [];
        container.volumeMounts.push({
          name: 'postgres-tls',
          mountPath: '/etc/ssl/certs/postgres-ca.crt',
          subPath: 'ca.crt',
          readOnly: true,
        });

        doc.spec.template.spec.volumes = doc.spec.template.spec.volumes || [];
        doc.spec.template.spec.volumes.push({
          name: 'postgres-tls',
          secret: {
            secretName: DEFAULT_POSTGRES_TLS_SECRET_NAME,
          },
        });
      }

      if (doc.kind === 'Deployment' && doc.metadata.name === 'quota-management-ui') {
        const container = doc.spec.template.spec.containers[0];
        const dbUrl = `postgres://budget:budget@quota-management-postgres:5432/budget_management?sslmode=require`;

        const dbUrlEnv = container.env.find(e => e.name === 'DATABASE_URL');
        if (dbUrlEnv) {
          dbUrlEnv.value = dbUrl;
        }

        container.volumeMounts = container.volumeMounts || [];
        container.volumeMounts.push({
          name: 'postgres-tls',
          mountPath: '/etc/ssl/certs/postgres-ca.crt',
          subPath: 'ca.crt',
          readOnly: true,
        });

        doc.spec.template.spec.volumes = doc.spec.template.spec.volumes || [];
        doc.spec.template.spec.volumes.push({
          name: 'postgres-tls',
          secret: {
            secretName: DEFAULT_POSTGRES_TLS_SECRET_NAME,
          },
        });
      }
    }

    return documents.map(doc => yaml.dump(doc, { lineWidth: -1, noRefs: true })).join('---\n');
  }

  async _readPatchAndFormatPostgresYaml() {
    let postgresYaml = await fs.readFile(join(__dirname, 'config', 'postgres.yaml'), 'utf8');
    const documents = yaml.loadAll(postgresYaml).filter(Boolean);

    for (const doc of documents) {
      if (doc.kind === 'StatefulSet' && doc.metadata.name === 'quota-management-postgres') {
        const container = doc.spec.template.spec.containers[0];

        container.env = container.env || [];
        container.env.push(
          { name: 'POSTGRES_SSL_MODE', value: 'require' },
          { name: 'POSTGRES_SSL_CERT_FILE', value: '/etc/ssl/certs/server.crt' },
          { name: 'POSTGRES_SSL_KEY_FILE', value: '/etc/ssl/private/server.key' },
          { name: 'POSTGRES_SSL_CA_FILE', value: '/etc/ssl/certs/ca.crt' }
        );

        container.volumeMounts = container.volumeMounts || [];
        container.volumeMounts.push({
          name: 'postgres-tls',
          mountPath: '/etc/ssl/certs/server.crt',
          subPath: 'tls.crt',
          readOnly: true,
        });
        container.volumeMounts.push({
          name: 'postgres-tls',
          mountPath: '/etc/ssl/private/server.key',
          subPath: 'tls.key',
          readOnly: true,
        });
        container.volumeMounts.push({
          name: 'postgres-tls',
          mountPath: '/etc/ssl/certs/ca.crt',
          subPath: 'ca.crt',
          readOnly: true,
        });

        doc.spec.template.spec.volumes = doc.spec.template.spec.volumes || [];
        doc.spec.template.spec.volumes.push({
          name: 'postgres-tls',
          secret: {
            secretName: DEFAULT_POSTGRES_TLS_SECRET_NAME,
            defaultMode: 0o600,
          },
        });
      }
    }

    return documents.map(doc => yaml.dump(doc, { lineWidth: -1, noRefs: true })).join('---\n');
  }

  async cleanup() {
    this.log('Cleaning up quota-budget resources...');

    await KubernetesHelper.kubectl(
      [
        'delete',
        'enterpriseagentgatewaypolicies',
        '-l',
        'agentgateway.dev/feature=quota-budget',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    await KubernetesHelper.kubectl(
      [
        'delete',
        'agentgatewaybackend',
        'keycloak-jwks',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    await KubernetesHelper.kubectl(
      [
        'delete',
        'backendtlspolicy',
        'keycloak-jwks-tls',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    await KubernetesHelper.kubectl(
      [
        'delete',
        'agentgatewaybackend',
        '-l',
        'agentgateway.dev/feature=quota-budget',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    await KubernetesHelper.kubectl(
      [
        'delete',
        'httproutes',
        '-l',
        'agentgateway.dev/feature=quota-budget',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    await KubernetesHelper.kubectl(
      [
        'delete',
        'gateway',
        'quota-management-https',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    await KubernetesHelper.kubectl(
      [
        'delete',
        'authconfigs',
        '-l',
        'agentgateway.dev/feature=quota-budget',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    await KubernetesHelper.kubectl(
      [
        'delete',
        'certificates',
        '-l',
        'agentgateway.dev/feature=quota-budget',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    await KubernetesHelper.kubectl(
      [
        'delete',
        'secrets',
        '-l',
        'agentgateway.dev/feature=quota-budget',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    await KubernetesHelper.kubectl(
      [
        'delete',
        'deployments',
        'quota-budget-extproc',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );
    await KubernetesHelper.kubectl(
      [
        'delete',
        'deployments',
        'quota-management-ui',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    await KubernetesHelper.kubectl(
      [
        'delete',
        'services',
        'quota-budget-extproc',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );
    await KubernetesHelper.kubectl(
      [
        'delete',
        'services',
        'quota-management-ui',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    await KubernetesHelper.kubectl(
      [
        'delete',
        'statefulsets',
        'quota-management-postgres',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );
    await KubernetesHelper.kubectl(
      [
        'delete',
        'services',
        'quota-management-postgres',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );
    await KubernetesHelper.kubectl(
      [
        'delete',
        'configmaps',
        'quota-management-postgres-init',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );
    await KubernetesHelper.kubectl(
      [
        'delete',
        'secrets',
        'quota-management-postgres-secret',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );
    await KubernetesHelper.kubectl(
      [
        'delete',
        'pvc',
        '-l',
        'app=quota-management-postgres',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    await KubernetesHelper.kubectl(
      [
        'delete',
        'podmonitor',
        'quota-budget-metrics',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    await KubernetesHelper.kubectl(
      [
        'delete',
        'serviceaccount',
        'quota-management',
        '-n',
        this.namespace,
        '--ignore-not-found=true',
      ],
      { ignoreError: true }
    );

    this.log('quota-budget cleanup complete');
  }
}

FeatureManager.register('quota-budget', QuotaBudgetFeature);

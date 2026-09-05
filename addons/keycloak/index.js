import { Feature, FeatureManager } from '../../src/lib/feature.js';
import {
  KubernetesHelper,
  LocalDnsHelper,
  CertificateHelper,
  CommandRunner,
  waitForPublicUrl,
  nlbSourceRangeAnnotations,
} from '../../src/lib/common.js';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, 'config');

const KEYCLOAK_VERSION = '26.6.2';
const POSTGRES_VERSION = '18.2-alpine';

/**
 * Keycloak Feature (manifest-based, no Helm)
 *
 * Deploys Keycloak + PostgreSQL via raw Kubernetes manifests.  After pods are
 * healthy the Keycloak Admin API is used to bootstrap a realm, a single OIDC
 * client, and test users.
 *
 * YAML templates live in ./config/ "and use {{VAR}} placeholders that are
 * resolved at deploy time.
 *
 * Requires the following environment variables (no defaults - deploy fails
 * cleanly via validate() if any are unset):
 *   KEYCLOAK_ADMIN_USERNAME       - Keycloak master realm bootstrap admin username
 *   KEYCLOAK_ADMIN_PASSWORD       - Keycloak master realm bootstrap admin password
 *   KEYCLOAK_POSTGRES_USER        - Postgres superuser backing Keycloak's DB
 *   KEYCLOAK_POSTGRES_PASSWORD    - Postgres superuser password
 *   SOLO_UI_DEFAULT_PASSWORD      - solo-admin/solo-reader/solo-writer bootstrap password
 *                                   (only required when soloUiClients.enabled is true)
 *   GRAFANA_REALM_ADMIN_USERNAME  - Grafana OIDC demo admin username (default: 'grafana-admin';
 *                                   only used when a 'grafana' realm is configured)
 *   GRAFANA_REALM_ADMIN_PASSWORD  - Grafana OIDC demo admin password (only required when a
 *                                   'grafana' realm is configured)
 */
export class KeycloakFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.keycloakVersion = config.keycloakVersion || config.version || KEYCLOAK_VERSION;
    // config.keycloakImage may be a bare repo (append keycloakVersion) or already a full
    // repo:tag reference - env files' `images.*` values are documented as full repo:tag
    // (see config/environments/*.yaml), so only append when there's no tag after the last '/'.
    const hasExplicitTag = /:[^/]+$/.test(config.keycloakImage || '');
    this.keycloakImage = config.keycloakImage
      ? hasExplicitTag
        ? config.keycloakImage
        : `${config.keycloakImage}:${this.keycloakVersion}`
      : `quay.io/keycloak/keycloak:${this.keycloakVersion}`;
    this.postgresVersion = config.postgresVersion || POSTGRES_VERSION;
    this.keycloakNamespace = config.keycloakNamespace || 'keycloak';
    this.hostname = config.hostname || 'keycloak.keycloak.svc.cluster.local';
    this.protocol = config.protocol || 'https';
    this.realm = config.realm || 'agw-dev';
    this.clientId = config.clientId || 'agw-client';
    this.clientSecret = config.clientSecret || 'agw-client-secret';
    this.publicClientId = config.publicClientId || 'agw-client-public';
    this.tlsEnabled = config.tls?.enabled !== false;
    this.tlsSecretName = config.tls?.secretName || 'keycloak-tls';
    this.createCertificate = config.tls?.createCertificate !== false;
    this.workloadClients = config.workloadClients || [];
    this.postgres = config.postgres || null;
    this.soloUiClients = config.soloUiClients || null;
    this.soloUiRealm = config.soloUiClients?.realm || 'solo-ui';
    this.loginTheme = config.loginTheme || null;
    this.adminUsername = process.env.KEYCLOAK_ADMIN_USERNAME || '';
    this.adminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD || '';
    this.postgresUser = process.env.KEYCLOAK_POSTGRES_USER || '';
    this.postgresPassword = process.env.KEYCLOAK_POSTGRES_PASSWORD || '';
    this.soloUiDefaultPassword = process.env.SOLO_UI_DEFAULT_PASSWORD || '';
    this.grafanaAdminUsername = process.env.GRAFANA_REALM_ADMIN_USERNAME || 'grafana-admin';
    this.grafanaAdminPassword = process.env.GRAFANA_REALM_ADMIN_PASSWORD || '';
    this.hasGrafanaRealm = (config.realms || []).some(r => r.realm === 'grafana');
    this.sourceRanges = config.sourceRanges || null;
  }

  validate() {
    const missing = [
      !this.adminUsername && 'KEYCLOAK_ADMIN_USERNAME',
      !this.adminPassword && 'KEYCLOAK_ADMIN_PASSWORD',
      !this.postgresUser && 'KEYCLOAK_POSTGRES_USER',
      !this.postgresPassword && 'KEYCLOAK_POSTGRES_PASSWORD',
      this.soloUiClients?.enabled && !this.soloUiDefaultPassword && 'SOLO_UI_DEFAULT_PASSWORD',
      this.hasGrafanaRealm && !this.grafanaAdminPassword && 'GRAFANA_REALM_ADMIN_PASSWORD',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(
        `Keycloak requires the following environment variable(s) to be set: ${missing.join(', ')}.\n` +
          'Set them before deploying, e.g.:\n' +
          '  export KEYCLOAK_ADMIN_USERNAME="admin"\n' +
          '  export KEYCLOAK_ADMIN_PASSWORD="<your-password>"\n' +
          '  export KEYCLOAK_POSTGRES_USER="postgres"\n' +
          '  export KEYCLOAK_POSTGRES_PASSWORD="<your-password>"\n' +
          '  export SOLO_UI_DEFAULT_PASSWORD="<your-password>"\n' +
          '  export GRAFANA_REALM_ADMIN_PASSWORD="<your-password>"'
      );
    }
    return true;
  }

  async deploy() {
    this.log('Installing Keycloak (manifest-based)...', 'info');

    await KubernetesHelper.ensureNamespace(this.keycloakNamespace, this.spinner);

    if (this.tlsEnabled && this.createCertificate) {
      await this.createTlsCertificate();
      await this.waitForCertificate();
    }

    await this.applyTemplate('postgres.yaml');
    await this.waitForPostgres();
    await this.initPostgresDb();
    await this.applyTemplate('keycloak.yaml');
    const nlbAnnotations = nlbSourceRangeAnnotations(this.sourceRanges);
    if (nlbAnnotations) {
      await KubernetesHelper.kubectl([
        'annotate',
        'service',
        'keycloak',
        '-n',
        this.keycloakNamespace,
        ...Object.entries(nlbAnnotations).map(([k, v]) => `${k}=${v}`),
        '--overwrite',
      ]);
      this.log('Annotated keycloak service for AWS NLB source-range gating', 'info');
    }
    await this.waitForKeycloak();
    await this.setupLocalDns();

    if (CertificateHelper.isExternalHostname(this.hostname)) {
      await waitForPublicUrl(this.hostname, {
        protocol: this.protocol,
        spinner: this.spinner,
        log: (msg, level) => this.log(msg, level),
      });
    }

    await this.configureKeycloak();

    this.log('Keycloak installed successfully', 'success');
    this.accessHint = `Access at ${this.protocol}://${this.hostname}/`;
  }

  // ---------------------------------------------------------------------------
  // Template helpers
  // ---------------------------------------------------------------------------

  templateVars() {
    // Credential values land inside single-quoted YAML scalars in keycloak.yaml/postgres.yaml
    // ('{{ADMIN_PASSWORD}}') - a literal ' in the value must be doubled per YAML's single-quote
    // escaping rule, or the raw substitution below produces unparseable YAML.
    const yamlSingleQuote = value => String(value).replace(/'/g, "''");
    return {
      NAMESPACE: this.keycloakNamespace,
      HOSTNAME: this.hostname,
      KEYCLOAK_IMAGE: this.keycloakImage,
      KEYCLOAK_VERSION: this.keycloakVersion,
      POSTGRES_VERSION: this.postgresVersion,
      POSTGRES_PVC_SIZE: this.postgres?.persistentVolume?.size || '5Gi',
      TLS_SECRET_NAME: this.tlsSecretName,
      STORAGE_CLASS_NAME: this.postgres?.persistentVolume?.storageClass || '',
      ADMIN_USERNAME: yamlSingleQuote(this.adminUsername),
      ADMIN_PASSWORD: yamlSingleQuote(this.adminPassword),
      POSTGRES_USER: yamlSingleQuote(this.postgresUser),
      POSTGRES_PASSWORD: yamlSingleQuote(this.postgresPassword),
    };
  }

  async applyTemplate(filename) {
    const raw = await readFile(join(CONFIG_DIR, filename), 'utf8');
    const vars = this.templateVars();
    const rendered = raw.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      if (vars[key] === undefined)
        throw new Error(`Unknown template variable: {{${key}}} in ${filename}`);
      return vars[key];
    });

    const docs = yaml.loadAll(rendered).filter(Boolean);
    for (const doc of docs) {
      // Remove empty storageClassName to use cluster default
      if (doc.kind === 'PersistentVolumeClaim' && doc.spec?.storageClassName === '') {
        delete doc.spec.storageClassName;
      }
      await this.applyResource(doc);
    }
  }

  // ---------------------------------------------------------------------------
  // TLS Certificate helpers
  // ---------------------------------------------------------------------------

  /**
   * Create TLS certificate using appropriate issuer:
   * - Let's Encrypt (DNS-01) for external DNS hostnames
   * - Self-signed for local/internal hostnames
   */
  async createTlsCertificate() {
    const issuerName = CertificateHelper.getIssuerName(this.hostname);
    const isExternal = CertificateHelper.isExternalHostname(this.hostname);

    this.log(
      `Creating ${isExternal ? "Let's Encrypt" : 'self-signed'} certificate for ${this.hostname}...`,
      'info'
    );

    const certificate = CertificateHelper.createCertificate({
      name: this.tlsSecretName,
      namespace: this.keycloakNamespace,
      hostname: this.hostname,
      additionalDnsNames: isExternal
        ? []
        : [
            `keycloak.${this.keycloakNamespace}.svc.cluster.local`,
            `keycloak.${this.keycloakNamespace}.svc`,
            'keycloak',
          ],
      issuerName,
    });

    await this.applyResource(certificate);
  }

  // ---------------------------------------------------------------------------
  // Wait helpers
  // ---------------------------------------------------------------------------

  async waitForCertificate() {
    this.log('Waiting for TLS certificate to be ready...', 'info');

    const ready = await CertificateHelper.waitForCertificate(
      this.keycloakNamespace,
      this.tlsSecretName,
      120, // 2 minutes
      this.spinner
    );

    if (ready) {
      this.log('TLS certificate is ready', 'info');
    } else {
      this.log('Certificate may not be fully ready yet, proceeding...', 'warn');
    }
  }

  async waitForPostgres() {
    this.log('Waiting for PostgreSQL to be ready...', 'info');
    try {
      await KubernetesHelper.cleanupAndWaitForDeployment(
        this.keycloakNamespace,
        'postgres',
        'app=postgres',
        300
      );
    } catch (error) {
      throw new Error(`PostgreSQL did not become ready: ${error.message}`);
    }
  }

  async initPostgresDb() {
    this.log('Initialising PostgreSQL database...', 'info');
    await new Promise(r => setTimeout(r, 5000));

    const execInPg = async sql => {
      try {
        await KubernetesHelper.kubectl(
          [
            '-n',
            this.keycloakNamespace,
            'exec',
            'deploy/postgres',
            '--',
            'psql',
            '-U',
            this.postgresUser,
            '-d',
            'postgres',
            '-c',
            sql,
          ],
          { ignoreError: true }
        );
      } catch {
        // ignore – object may already exist
      }
    };

    await execInPg('CREATE DATABASE keycloak;');
    await execInPg("CREATE USER keycloak WITH PASSWORD 'password';");
    await execInPg('GRANT ALL PRIVILEGES ON DATABASE keycloak TO keycloak;');
  }

  async waitForKeycloak() {
    this.log('Waiting for Keycloak to be ready...', 'info');
    try {
      await KubernetesHelper.cleanupAndWaitForDeployment(
        this.keycloakNamespace,
        'keycloak',
        'app=keycloak',
        600
      );
    } catch (error) {
      this.log(`Keycloak may not be fully ready: ${error.message}`, 'warn');
    }
  }

  // ---------------------------------------------------------------------------
  // Local DNS (/etc/hosts) so the browser can reach Keycloak via its hostname
  // Only used for local/internal hostnames; skipped when using external DNS
  // ---------------------------------------------------------------------------

  async setupLocalDns() {
    const lbAddress = await this.waitForLoadBalancer();

    const result = await LocalDnsHelper.ensureHostsEntry(this.hostname, lbAddress, {
      spinner: this.spinner,
      featureName: this.name,
    });

    if (result.error) {
      this.log(result.message, 'warn');
    } else if (result.added) {
      this.log(result.message, 'success');
    } else {
      this.log(result.message, 'info');
    }
  }

  async waitForLoadBalancer() {
    this.log('Waiting for Keycloak LoadBalancer IP...', 'info');

    for (let i = 0; i < 60; i++) {
      try {
        const result = await KubernetesHelper.kubectl(
          [
            'get',
            'svc',
            'keycloak',
            '-n',
            this.keycloakNamespace,
            '-o',
            'jsonpath={.status.loadBalancer.ingress[0].ip}{.status.loadBalancer.ingress[0].hostname}',
          ],
          { ignoreError: true }
        );

        const addr = (result.stdout || '').replace(/"/g, '').trim();
        if (addr) {
          this.lbAddress = addr;
          return addr;
        }
      } catch {
        /* not ready yet */
      }
      await new Promise(r => setTimeout(r, 5000));
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Post-deploy Keycloak configuration via Admin REST API
  // ---------------------------------------------------------------------------

  /**
   * Build curl args with --resolve to bypass DNS when LB address is known.
   * Resolves ELB hostnames to IPs since curl --resolve requires an IP address.
   * Falls back to empty args (DNS resolution) if lookup fails.
   */
  async resolveCurlArgs() {
    if (!this.lbAddress) {
      this.log('resolveCurlArgs: no lbAddress, skipping --resolve', 'debug');
      return [];
    }

    this.log(`resolveCurlArgs: lbAddress=${this.lbAddress}`, 'debug');

    // If it's already an IP, use it directly
    if (/^\d+\.\d+\.\d+\.\d+$/.test(this.lbAddress)) {
      const port = this.protocol === 'https' ? 443 : 80;
      const args = ['--resolve', `${this.hostname}:${port}:${this.lbAddress}`];
      this.log(`resolveCurlArgs: IP detected, resolve=${args.join(' ')}`, 'debug');
      return args;
    }

    // Resolve ELB hostname to IP via DNS
    try {
      const { promises: dns } = await import('dns');
      this.log(`resolveCurlArgs: resolving ELB hostname via DNS...`, 'debug');
      const addresses = await dns.resolve4(this.lbAddress);
      this.log(`resolveCurlArgs: resolved to ${addresses.join(', ')}`, 'debug');
      if (addresses.length > 0) {
        const port = this.protocol === 'https' ? 443 : 80;
        const args = ['--resolve', `${this.hostname}:${port}:${addresses[0]}`];
        this.log(`resolveCurlArgs: resolve=${args.join(' ')}`, 'debug');
        return args;
      }
    } catch (err) {
      this.log(`resolveCurlArgs: DNS lookup failed: ${err.message}`, 'debug');
    }

    return [];
  }

  /**
   * Get the base URL for Admin API calls (always uses the configured hostname).
   */
  getAdminBaseUrl() {
    return `${this.protocol}://${this.hostname}`;
  }

  async configureKeycloak() {
    this.log('Configuring Keycloak via Admin API...', 'info');

    // Resolve LB address to IP once for all curl calls
    this.curlResolveArgs = await this.resolveCurlArgs();

    const baseUrl = this.getAdminBaseUrl();
    let token = await this.getAdminToken(baseUrl);

    if (this.config.realms?.length) {
      // Config-driven path: process all realms from profile config
      await this.setupRealms(baseUrl, token, this.config.realms);
    } else {
      // Legacy path: backward compat for profiles without realms array
      await this.createRealm(baseUrl, token);
      await this.configureUserProfile(baseUrl, token);
      await this.createConfidentialClient(baseUrl, token);
      await this.createPublicClient(baseUrl, token);
      await this.createQuotaManagementClient(baseUrl, token);
      await this.createUsers(baseUrl, token);
    }

    if (this.workloadClients.length > 0) {
      // Admin tokens are short-lived (Keycloak defaults to 60s); refetch rather than
      // reuse a token that may already be stale after the realm setup above.
      token = await this.getAdminToken(baseUrl);
      await this.configureWorkloadClients(baseUrl, token);
    }

    if (this.soloUiClients?.enabled) {
      token = await this.getAdminToken(baseUrl);
      await this.createSoloUIClients(baseUrl, token);
    }

    this.log('Keycloak configuration complete', 'info');
  }

  async configureUserProfile(baseUrl, token) {
    this.log('Configuring User Profile attributes...', 'info');

    // Get current user profile config
    const getResult = await CommandRunner.run(
      'curl',
      [
        '-sSfk',
        ...(this.curlResolveArgs || []),
        '-H',
        `Authorization: Bearer ${token}`,
        `${baseUrl}/admin/realms/${this.realm}/users/profile`,
      ],
      { ignoreError: true }
    );

    let profile;
    try {
      profile = JSON.parse(getResult.stdout);
    } catch {
      this.log('Could not parse user profile, using defaults', 'warn');
      profile = { attributes: [] };
    }

    // Custom attributes we need for budget management
    const customAttributes = [
      {
        name: 'group',
        displayName: 'Group',
        permissions: { view: ['admin', 'user'], edit: ['admin'] },
        validations: {},
      },
      {
        name: 'org_id',
        displayName: 'Organization ID',
        permissions: { view: ['admin', 'user'], edit: ['admin'] },
        validations: {},
      },
      {
        name: 'team_id',
        displayName: 'Team ID',
        permissions: { view: ['admin', 'user'], edit: ['admin'] },
        validations: {},
      },
      {
        name: 'is_org_admin',
        displayName: 'Is Org Admin',
        permissions: { view: ['admin', 'user'], edit: ['admin'] },
        validations: {},
      },
      {
        name: 'is_team_admin',
        displayName: 'Is Team Admin',
        permissions: { view: ['admin', 'user'], edit: ['admin'] },
        validations: {},
      },
    ];

    // Add custom attributes if they don't exist
    const existingNames = new Set(profile.attributes.map(a => a.name));
    for (const attr of customAttributes) {
      if (!existingNames.has(attr.name)) {
        profile.attributes.push(attr);
        this.log(`Adding user profile attribute: ${attr.name}`, 'info');
      }
    }

    // Update the user profile
    await this.kcApi('PUT', `${baseUrl}/admin/realms/${this.realm}/users/profile`, token, profile);
    this.log('User Profile configured', 'info');
  }

  async createQuotaManagementClient(baseUrl, token) {
    this.log('Creating quota-management client...', 'info');

    const payload = {
      clientId: 'quota-management',
      secret: 'quota-management-secret',
      enabled: true,
      publicClient: false,
      standardFlowEnabled: true,
      serviceAccountsEnabled: false,
      directAccessGrantsEnabled: true,
      redirectUris: ['*'],
      webOrigins: ['*'],
      attributes: {
        'post.logout.redirect.uris': '*',
        'access.token.signed.response.alg': 'RS256',
        'id.token.signed.response.alg': 'RS256',
      },
    };

    const result = await this.registerClient(baseUrl, token, payload);
    let id = this.extractIdFromLocation(result.stdout);
    if (!id) id = await this.lookupClientId(baseUrl, token, 'quota-management');

    if (id) {
      await this.addGroupMapper(baseUrl, token, id);
      await this.addOrgIdMapper(baseUrl, token, id);
      await this.addTeamIdMapper(baseUrl, token, id);
      await this.addIsOrgAdminMapper(baseUrl, token, id);
      await this.addIsTeamAdminMapper(baseUrl, token, id);
    }

    this.log(
      'quota-management client created with org_id/team_id/is_org_admin/is_team_admin claim mappers',
      'info'
    );
    return id;
  }

  // ---------------------------------------------------------------------------
  // Workload identity clients
  // ---------------------------------------------------------------------------

  async configureWorkloadClients(baseUrl, token) {
    this.log(`Configuring ${this.workloadClients.length} workload client(s)...`, 'info');
    let k8sIdpRegistered = false;

    for (const client of this.workloadClients) {
      token = await this.getAdminToken(baseUrl);
      const clientInternalId = await this.createWorkloadClient(baseUrl, token, client);

      if (clientInternalId) {
        await this.addAudienceMapper(
          baseUrl,
          token,
          clientInternalId,
          client.audience || 'agentgateway'
        );

        if (client.configureTokenExchange) {
          if (!k8sIdpRegistered) {
            await this.registerK8sIdentityProvider(
              baseUrl,
              token,
              client.k8sOidcIssuer || 'https://kubernetes.default.svc.cluster.local',
              client.k8sJwksUrl || 'https://kubernetes.default.svc.cluster.local/openid/v1/jwks'
            );
            k8sIdpRegistered = true;
          }
        }
      }

      if (client.k8sSecretName) {
        await this.createWorkloadClientSecret(client);
      }
    }
  }

  async createWorkloadClient(baseUrl, token, client) {
    const clientId = client.clientId;
    this.log(`Creating workload client '${clientId}'...`, 'info');

    const payload = {
      clientId,
      enabled: true,
      publicClient: false,
      standardFlowEnabled: false,
      serviceAccountsEnabled: true,
      directAccessGrantsEnabled: false,
      attributes: { 'access.token.signed.response.alg': 'RS256' },
    };
    if (client.clientSecret) payload.secret = client.clientSecret;

    const result = await CommandRunner.run(
      'curl',
      [
        '-sSik',
        ...(this.curlResolveArgs || []),
        '-X',
        'POST',
        '-H',
        `Authorization: Bearer ${token}`,
        '-H',
        'Content-Type: application/json',
        '-d',
        JSON.stringify(payload),
        `${baseUrl}/admin/realms/${this.realm}/clients`,
      ],
      { ignoreError: true }
    );

    let id = this.extractIdFromLocation(result.stdout);
    if (!id) id = await this.lookupClientId(baseUrl, token, clientId);

    if (id) {
      this.log(`Workload client '${clientId}' created (internal id: ${id})`, 'info');
    } else {
      this.log(`Workload client '${clientId}' may already exist`, 'warn');
    }
    return id;
  }

  async addAudienceMapper(baseUrl, token, clientInternalId, audience) {
    this.log(`Adding audience mapper (aud=${audience})...`, 'info');
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${this.realm}/clients/${clientInternalId}/protocol-mappers/models`,
      token,
      {
        name: `audience-${audience}`,
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: {
          'included.custom.audience': audience,
          'access.token.claim': 'true',
          'id.token.claim': 'false',
        },
      }
    );
  }

  async registerK8sIdentityProvider(baseUrl, token, issuer, jwksUrl) {
    this.log(`Registering Kubernetes OIDC identity provider (issuer=${issuer})...`, 'info');
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${this.realm}/identity-provider/instances`,
      token,
      {
        providerId: 'oidc',
        alias: 'kubernetes',
        displayName: 'Kubernetes',
        enabled: true,
        trustEmail: false,
        storeToken: false,
        addReadTokenRoleOnCreate: false,
        config: {
          validateSignature: 'true',
          useJwksUrl: 'true',
          jwksUrl,
          issuer,
          tokenUrl: `${issuer}/openid/v1/token`,
          authorizationUrl: `${issuer}/openid/v1/auth`,
          disableUserInfoService: 'true',
          clientAuthMethod: 'client_secret_post',
          syncMode: 'IMPORT',
        },
      }
    );
  }

  async createWorkloadClientSecret(client) {
    const secretNamespace = client.k8sSecretNamespace || FeatureManager.getDefaultNamespace();
    this.log(
      `Creating K8s Secret '${client.k8sSecretName}' in namespace '${secretNamespace}'...`,
      'info'
    );

    await KubernetesHelper.ensureNamespace(secretNamespace, this.spinner);

    await this.applyResource({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: client.k8sSecretName,
        namespace: secretNamespace,
        labels: { 'app.kubernetes.io/managed-by': 'agentgateway-demo' },
      },
      type: 'Opaque',
      stringData: { client_secret: client.clientSecret },
    });
  }

  // ---------------------------------------------------------------------------
  // Solo UI Clients and Groups
  // ---------------------------------------------------------------------------

  async createSoloUIRealm(baseUrl, token) {
    if (await this.realmExists(baseUrl, token, this.soloUiRealm)) {
      this.log(`Realm '${this.soloUiRealm}' already exists, skipping creation`, 'info');
    } else {
      this.log(`Creating Solo UI realm '${this.soloUiRealm}'...`, 'info');
      await this.kcApi('POST', `${baseUrl}/admin/realms`, token, {
        realm: this.soloUiRealm,
        enabled: true,
        displayName: 'Solo Enterprise UI',
        loginWithEmailAllowed: true,
        duplicateEmailsAllowed: false,
        resetPasswordAllowed: true,
        editUsernameAllowed: false,
        bruteForceProtected: false,
      });
    }
    await this.ensureRealmLoginTheme(baseUrl, token, this.soloUiRealm);
  }

  async createSoloUIClients(baseUrl, token) {
    const { hostname, backendClientId, backendClientSecret, frontendClientId } = this.soloUiClients;
    const realm = this.soloUiRealm;
    const redirectUri = `${hostname}/callback`;
    const postLogoutUri = `${hostname}/logout`;

    await this.createSoloUIRealm(baseUrl, token);

    this.log(`Creating Solo UI backend client '${backendClientId}'...`, 'info');

    const backendPayload = {
      clientId: backendClientId,
      secret: backendClientSecret,
      enabled: true,
      publicClient: false,
      standardFlowEnabled: true,
      serviceAccountsEnabled: true,
      directAccessGrantsEnabled: false,
      redirectUris: [redirectUri],
      webOrigins: ['*'],
      attributes: {
        'post.logout.redirect.uris': postLogoutUri,
        'pkce.code.challenge.method': '',
        'access.token.signed.response.alg': 'RS256',
        'id.token.signed.response.alg': 'RS256',
      },
    };

    const backendResult = await this.registerClient(baseUrl, token, backendPayload, realm);
    let backendId = this.extractIdFromLocation(backendResult.stdout);
    if (!backendId) backendId = await this.lookupClientId(baseUrl, token, backendClientId, realm);

    if (backendId) {
      await this.addGroupsClaimMapper(baseUrl, token, backendId, realm);
    }

    this.log(`Creating Solo UI frontend client '${frontendClientId}'...`, 'info');

    const frontendPayload = {
      clientId: frontendClientId,
      enabled: true,
      publicClient: true,
      standardFlowEnabled: true,
      serviceAccountsEnabled: false,
      directAccessGrantsEnabled: false,
      redirectUris: [redirectUri],
      webOrigins: ['*'],
      attributes: {
        'post.logout.redirect.uris': postLogoutUri,
        'pkce.code.challenge.method': 'S256',
        'access.token.signed.response.alg': 'RS256',
        'id.token.signed.response.alg': 'RS256',
      },
    };

    const frontendResult = await this.registerClient(baseUrl, token, frontendPayload, realm);
    let frontendId = this.extractIdFromLocation(frontendResult.stdout);
    if (!frontendId)
      frontendId = await this.lookupClientId(baseUrl, token, frontendClientId, realm);

    if (frontendId) {
      await this.addGroupsClaimMapper(baseUrl, token, frontendId, realm);
    }

    const groupIds = await this.createSoloUIGroups(baseUrl, token);
    await this.createSoloUIUsers(baseUrl, token, groupIds);

    this.log('Solo UI clients, groups, and users created', 'success');
  }

  async createSoloUIGroups(baseUrl, token) {
    const realm = this.soloUiRealm;
    const groupNames = ['admins', 'readers', 'writers'];
    const groupsUrl = `${baseUrl}/admin/realms/${realm}/groups`;

    const groupIds = {};
    for (const group of groupNames) {
      this.log(`Creating Keycloak group '${group}'...`, 'info');
      await this.kcApi('POST', groupsUrl, token, { name: group });

      // Re-fetch groups list to get IDs (POST only returns Location, not body)
      const listResult = await this.kcApi('GET', groupsUrl, token);
      let allGroups = [];
      try {
        allGroups = JSON.parse(listResult.stdout);
      } catch {
        /* ignore parse error */
      }
      const created = allGroups.find(g => g.name === group);
      if (created) groupIds[group] = created.id;
    }

    return groupIds;
  }

  async createSoloUIUsers(baseUrl, token, groupIds) {
    const realm = this.soloUiRealm;
    const users = [
      {
        username: 'solo-admin',
        email: 'solo-admin@solo.io',
        firstName: 'Solo',
        lastName: 'Admin',
        group: 'admins',
      },
      {
        username: 'solo-reader',
        email: 'solo-reader@solo.io',
        firstName: 'Solo',
        lastName: 'Reader',
        group: 'readers',
      },
      {
        username: 'solo-writer',
        email: 'solo-writer@solo.io',
        firstName: 'Solo',
        lastName: 'Writer',
        group: 'writers',
      },
    ];

    const password = this.soloUiDefaultPassword;
    for (const user of users) {
      this.log(`Creating Solo UI user '${user.username}'...`, 'info');
      await this.createOrUpdateUserWithPassword(
        baseUrl,
        token,
        user.username,
        realm,
        {},
        password,
        {
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
        }
      );

      const userId = await this.lookupUserId(baseUrl, token, user.username, realm);
      const groupId = groupIds[user.group];
      if (userId && groupId) {
        await this.kcApi(
          'PUT',
          `${baseUrl}/admin/realms/${realm}/users/${userId}/groups/${groupId}`,
          token
        );
        this.log(`Added '${user.username}' to '${user.group}' group`, 'info');
      }
    }
  }

  /**
   * Check whether a realm already exists. Uses a plain status-code check rather than kcApi()
   * so the expected "not found" case on a fresh install doesn't log a warning.
   */
  async realmExists(baseUrl, token, realmName) {
    const result = await CommandRunner.run(
      'curl',
      [
        '-sSk',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        ...(this.curlResolveArgs || []),
        '-H',
        `Authorization: Bearer ${token}`,
        `${baseUrl}/admin/realms/${realmName}`,
      ],
      { ignoreError: true }
    );
    return result.stdout?.trim() === '200';
  }

  /**
   * Set the realm's login theme when configured. Keycloak's realm PUT only applies
   * fields present in the body, so this is safe to call for both newly-created and
   * pre-existing realms without disturbing other realm settings.
   */
  async ensureRealmLoginTheme(baseUrl, token, realmName) {
    if (!this.loginTheme) return;
    await this.kcApi('PUT', `${baseUrl}/admin/realms/${realmName}`, token, {
      loginTheme: this.loginTheme,
    });
  }

  /**
   * Names of protocol mappers already configured on a client, so callers can skip
   * re-creating ones that already exist instead of hitting a 409 on rerun.
   */
  async listProtocolMapperNames(baseUrl, token, clientInternalId, realm) {
    const result = await this.kcApi(
      'GET',
      `${baseUrl}/admin/realms/${realm}/clients/${clientInternalId}/protocol-mappers/models`,
      token
    );
    try {
      return new Set(JSON.parse(result.stdout || '[]').map(m => m.name));
    } catch {
      return new Set();
    }
  }

  async kcApi(method, url, token, body) {
    const args = [
      '-sSfk',
      '--max-time',
      '10',
      ...(this.curlResolveArgs || []),
      '-X',
      method,
      '-H',
      `Authorization: Bearer ${token}`,
      '-H',
      'Content-Type: application/json',
    ];
    if (body) args.push('-d', JSON.stringify(body));
    args.push(url);
    const result = await CommandRunner.run('curl', args, { ignoreError: true });
    if (result.exitCode !== 0) {
      const detail = result.stderr || result.message || 'unknown error';
      // 409 Conflict just means the named resource (realm/client/mapper/group) already
      // exists - expected whenever this addon reruns against an already-configured
      // Keycloak, not a real failure. Every other status still warns normally.
      const level = /\b409\b/.test(detail) ? 'debug' : 'warn';
      this.log(`Keycloak API ${method} ${url} failed (exit ${result.exitCode}): ${detail}`, level);
    }
    return result;
  }

  async getAdminToken(baseUrl) {
    this.log('Obtaining admin token...', 'info');
    this.log(`getAdminToken: baseUrl=${baseUrl}`, 'debug');
    this.log(
      `getAdminToken: curlResolveArgs=${JSON.stringify(this.curlResolveArgs || [])}`,
      'debug'
    );

    for (let i = 0; i < 30; i++) {
      try {
        const curlArgs = [
          '-sSfk',
          '--max-time',
          '10',
          ...(this.curlResolveArgs || []),
          '-X',
          'POST',
          `${baseUrl}/realms/master/protocol/openid-connect/token`,
          '-H',
          'Content-Type: application/x-www-form-urlencoded',
          '-d',
          `username=${encodeURIComponent(this.adminUsername)}&password=${encodeURIComponent(this.adminPassword)}&grant_type=password&client_id=admin-cli`,
        ];
        this.log(
          `getAdminToken attempt ${i + 1}: curl ${curlArgs.filter(a => !a.includes('password')).join(' ')}`,
          'debug'
        );

        const result = await CommandRunner.run('curl', curlArgs, { ignoreError: true });

        this.log(`getAdminToken stdout=${result.stdout?.substring(0, 200)}`, 'debug');
        if (result.stderr)
          this.log(`getAdminToken stderr=${result.stderr?.substring(0, 200)}`, 'debug');

        if (result.stdout) {
          const parsed = JSON.parse(result.stdout);
          if (parsed.access_token) return parsed.access_token;
          this.log(
            `getAdminToken: no access_token in response: ${JSON.stringify(parsed).substring(0, 200)}`,
            'debug'
          );
        }
      } catch (err) {
        this.log(`getAdminToken error: ${err.message}`, 'debug');
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error('Failed to obtain Keycloak admin token');
  }

  async createRealm(baseUrl, token) {
    if (await this.realmExists(baseUrl, token, this.realm)) {
      this.log(`Realm '${this.realm}' already exists, skipping creation`, 'info');
    } else {
      this.log(`Creating realm '${this.realm}'...`, 'info');
      await this.kcApi('POST', `${baseUrl}/admin/realms`, token, {
        realm: this.realm,
        enabled: true,
        displayName: this.realm,
        loginWithEmailAllowed: true,
        duplicateEmailsAllowed: false,
        resetPasswordAllowed: true,
        editUsernameAllowed: false,
        bruteForceProtected: false,
        accessCodeLifespan: 300,
        accessCodeLifespanUserAction: 600,
        accessCodeLifespanLogin: 1800,
      });
    }
    await this.ensureRealmLoginTheme(baseUrl, token, this.realm);
  }

  async createConfidentialClient(baseUrl, token) {
    this.log(`Creating confidential client '${this.clientId}'...`, 'info');

    const payload = {
      clientId: this.clientId,
      secret: this.clientSecret,
      enabled: true,
      publicClient: false,
      standardFlowEnabled: true,
      serviceAccountsEnabled: true,
      directAccessGrantsEnabled: true,
      authorizationServicesEnabled: true,
      redirectUris: ['*'],
      webOrigins: ['*'],
      attributes: {
        'post.logout.redirect.uris': '*',
        'access.token.signed.response.alg': 'RS256',
        'id.token.signed.response.alg': 'RS256',
      },
    };

    const result = await this.registerClient(baseUrl, token, payload);
    let id = this.extractIdFromLocation(result.stdout);
    if (!id) id = await this.lookupClientId(baseUrl, token, this.clientId);

    if (id) {
      await this.addGroupMapper(baseUrl, token, id);
      await this.addOrgIdMapper(baseUrl, token, id);
      await this.addTeamIdMapper(baseUrl, token, id);
      await this.addIsOrgAdminMapper(baseUrl, token, id);
      await this.addIsTeamAdminMapper(baseUrl, token, id);
    }

    process.env.KEYCLOAK_CLIENT_ID = this.clientId;
    process.env.KEYCLOAK_SECRET = this.clientSecret;
    this.log('Client credentials exported to KEYCLOAK_CLIENT_ID / KEYCLOAK_SECRET', 'info');

    return id;
  }

  async createPublicClient(baseUrl, token) {
    this.log(`Creating public client '${this.publicClientId}'...`, 'info');

    const payload = {
      clientId: this.publicClientId,
      enabled: true,
      publicClient: true,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      redirectUris: ['*'],
      webOrigins: ['*'],
      attributes: {
        'post.logout.redirect.uris': '*',
        'pkce.code.challenge.method': 'S256',
        'access.token.signed.response.alg': 'RS256',
        'id.token.signed.response.alg': 'RS256',
      },
    };

    const result = await this.registerClient(baseUrl, token, payload);
    let id = this.extractIdFromLocation(result.stdout);
    if (!id) id = await this.lookupClientId(baseUrl, token, this.publicClientId);

    if (id) {
      await this.addGroupMapper(baseUrl, token, id);
      await this.addOrgIdMapper(baseUrl, token, id);
      await this.addTeamIdMapper(baseUrl, token, id);
      await this.addIsOrgAdminMapper(baseUrl, token, id);
      await this.addIsTeamAdminMapper(baseUrl, token, id);
    }

    return id;
  }

  async registerClient(baseUrl, token, payload, realm = this.realm) {
    return CommandRunner.run(
      'curl',
      [
        '-sSik',
        ...(this.curlResolveArgs || []),
        '-X',
        'POST',
        '-H',
        `Authorization: Bearer ${token}`,
        '-H',
        'Content-Type: application/json',
        '-d',
        JSON.stringify(payload),
        `${baseUrl}/admin/realms/${realm}/clients`,
      ],
      { ignoreError: true }
    );
  }

  async addGroupMapper(baseUrl, token, clientInternalId) {
    this.log('Adding group attribute mapper...', 'info');
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${this.realm}/clients/${clientInternalId}/protocol-mappers/models`,
      token,
      {
        name: 'group',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-attribute-mapper',
        config: {
          'claim.name': 'group',
          'jsonType.label': 'String',
          'user.attribute': 'group',
          'id.token.claim': 'true',
          'access.token.claim': 'true',
        },
      }
    );
  }

  async addOrgIdMapper(baseUrl, token, clientInternalId) {
    this.log('Adding org_id attribute mapper...', 'info');
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${this.realm}/clients/${clientInternalId}/protocol-mappers/models`,
      token,
      {
        name: 'org_id',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-attribute-mapper',
        config: {
          'claim.name': 'org_id',
          'jsonType.label': 'String',
          'user.attribute': 'org_id',
          'id.token.claim': 'true',
          'access.token.claim': 'true',
        },
      }
    );
  }

  async addTeamIdMapper(baseUrl, token, clientInternalId) {
    this.log('Adding team_id attribute mapper...', 'info');
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${this.realm}/clients/${clientInternalId}/protocol-mappers/models`,
      token,
      {
        name: 'team_id',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-attribute-mapper',
        config: {
          'claim.name': 'team_id',
          'jsonType.label': 'String',
          'user.attribute': 'team_id',
          'id.token.claim': 'true',
          'access.token.claim': 'true',
        },
      }
    );
  }

  async addIsOrgAdminMapper(baseUrl, token, clientInternalId) {
    this.log('Adding is_org_admin attribute mapper...', 'info');
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${this.realm}/clients/${clientInternalId}/protocol-mappers/models`,
      token,
      {
        name: 'is_org_admin',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-attribute-mapper',
        config: {
          'claim.name': 'is_org_admin',
          'jsonType.label': 'boolean',
          'user.attribute': 'is_org_admin',
          'id.token.claim': 'true',
          'access.token.claim': 'true',
        },
      }
    );
  }

  async addIsTeamAdminMapper(baseUrl, token, clientInternalId) {
    this.log('Adding is_team_admin attribute mapper...', 'info');
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${this.realm}/clients/${clientInternalId}/protocol-mappers/models`,
      token,
      {
        name: 'is_team_admin',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-attribute-mapper',
        config: {
          'claim.name': 'is_team_admin',
          'jsonType.label': 'boolean',
          'user.attribute': 'is_team_admin',
          'id.token.claim': 'true',
          'access.token.claim': 'true',
        },
      }
    );
  }

  async addAttributeMapper(baseUrl, token, clientInternalId, realmName, attrName) {
    this.log(`Adding ${attrName} attribute mapper to realm '${realmName}'...`, 'info');
    const jsonType =
      attrName === 'is_org_admin' || attrName === 'is_team_admin' ? 'boolean' : 'String';
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${realmName}/clients/${clientInternalId}/protocol-mappers/models`,
      token,
      {
        name: attrName,
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-attribute-mapper',
        config: {
          'claim.name': attrName,
          'jsonType.label': jsonType,
          'user.attribute': attrName,
          'id.token.claim': 'true',
          'access.token.claim': 'true',
        },
      }
    );
  }

  async setServiceAccountAttributes(baseUrl, token, clientInternalId, realmName, attrs) {
    const result = await this.kcApi(
      'GET',
      `${baseUrl}/admin/realms/${realmName}/clients/${clientInternalId}/service-account-user`,
      token
    );
    let svcUser;
    try {
      svcUser = JSON.parse(result.stdout);
    } catch {
      return;
    }
    if (!svcUser?.id) return;

    const kAttrs = {};
    for (const [k, v] of Object.entries(attrs)) {
      kAttrs[k] = Array.isArray(v) ? v : [String(v)];
    }
    await this.kcApi('PUT', `${baseUrl}/admin/realms/${realmName}/users/${svcUser.id}`, token, {
      attributes: kAttrs,
    });
  }

  async configureUserProfileForRealm(baseUrl, token, realmName, attrNames) {
    this.log(`Configuring user profile attributes for realm '${realmName}'...`, 'info');
    const getResult = await CommandRunner.run(
      'curl',
      [
        '-sSfk',
        ...(this.curlResolveArgs || []),
        '-H',
        `Authorization: Bearer ${token}`,
        `${baseUrl}/admin/realms/${realmName}/users/profile`,
      ],
      { ignoreError: true }
    );

    let profile;
    try {
      profile = JSON.parse(getResult.stdout);
    } catch {
      profile = { attributes: [] };
    }

    const existingNames = new Set((profile.attributes || []).map(a => a.name));
    for (const name of attrNames) {
      if (!existingNames.has(name)) {
        profile.attributes.push({
          name,
          displayName: name,
          permissions: { view: ['admin', 'user'], edit: ['admin'] },
          validations: {},
        });
      }
    }

    await this.kcApi('PUT', `${baseUrl}/admin/realms/${realmName}/users/profile`, token, profile);
  }

  async createNamedRealm(baseUrl, token, realmName) {
    if (await this.realmExists(baseUrl, token, realmName)) {
      this.log(`Realm '${realmName}' already exists, skipping creation`, 'info');
    } else {
      this.log(`Creating realm '${realmName}'...`, 'info');
      await this.kcApi('POST', `${baseUrl}/admin/realms`, token, {
        realm: realmName,
        enabled: true,
        displayName: realmName,
        loginWithEmailAllowed: true,
        duplicateEmailsAllowed: false,
        resetPasswordAllowed: true,
        editUsernameAllowed: false,
        bruteForceProtected: false,
        accessCodeLifespan: 300,
        accessCodeLifespanUserAction: 600,
        accessCodeLifespanLogin: 1800,
      });
    }
    await this.ensureRealmLoginTheme(baseUrl, token, realmName);
  }

  async createOrUpdateUserWithPassword(
    baseUrl,
    token,
    username,
    realmName,
    attrs,
    password,
    profile = {}
  ) {
    const kAttrs = {};
    for (const [k, v] of Object.entries(attrs || {})) {
      kAttrs[k] = Array.isArray(v) ? v : [v];
    }

    const firstName = profile.firstName;
    const lastName = profile.lastName;
    const email = profile.email;

    const existingId = await this.lookupUserId(baseUrl, token, username, realmName);
    if (existingId) {
      this.log(`Updating user '${username}' in realm '${realmName}'...`, 'info');
      await this.kcApi('PUT', `${baseUrl}/admin/realms/${realmName}/users/${existingId}`, token, {
        firstName,
        lastName,
        email,
        enabled: true,
        emailVerified: true,
        attributes: kAttrs,
      });
      await this.kcApi(
        'PUT',
        `${baseUrl}/admin/realms/${realmName}/users/${existingId}/reset-password`,
        token,
        { type: 'password', value: password, temporary: false }
      );
    } else {
      this.log(`Creating user '${username}' in realm '${realmName}'...`, 'info');
      await this.kcApi('POST', `${baseUrl}/admin/realms/${realmName}/users`, token, {
        username,
        firstName,
        lastName,
        email,
        enabled: true,
        emailVerified: true,
        credentials: [{ type: 'password', value: password, temporary: false }],
        attributes: kAttrs,
      });
    }
  }

  async setupStandardRealm(baseUrl, token, realm) {
    this.log(`Setting up standard realm '${realm.realm}'...`, 'info');
    await this.createNamedRealm(baseUrl, token, realm.realm);

    if (realm.customAttributes?.length) {
      await this.configureUserProfileForRealm(baseUrl, token, realm.realm, realm.customAttributes);
    }

    for (const client of realm.clients || []) {
      token = await this.getAdminToken(baseUrl);
      const payload = {
        clientId: client.clientId,
        enabled: true,
        publicClient: client.type === 'public',
        standardFlowEnabled: client.flows?.includes('authorization-code') ?? true,
        serviceAccountsEnabled: client.flows?.includes('service-account') ?? false,
        directAccessGrantsEnabled: client.directAccessGrantsEnabled ?? true,
        redirectUris: ['*'],
        webOrigins: ['*'],
        attributes: {
          'post.logout.redirect.uris': '*',
          'access.token.signed.response.alg': 'RS256',
          'id.token.signed.response.alg': 'RS256',
          ...client.attributes,
        },
      };
      if (client.clientSecret) payload.secret = client.clientSecret;

      const result = await this.registerClient(baseUrl, token, payload, realm.realm);
      let id = this.extractIdFromLocation(result.stdout);
      if (!id) id = await this.lookupClientId(baseUrl, token, client.clientId, realm.realm);

      if (id && realm.customAttributes?.length) {
        const existingMapperNames = await this.listProtocolMapperNames(
          baseUrl,
          token,
          id,
          realm.realm
        );
        for (const attrName of realm.customAttributes) {
          if (existingMapperNames.has(attrName)) continue;
          await this.addAttributeMapper(baseUrl, token, id, realm.realm, attrName);
        }
      }
    }

    const isGrafanaRealm = realm.realm === 'grafana';
    const defaultPassword = isGrafanaRealm ? this.grafanaAdminPassword : realm.defaultPassword;
    for (const user of realm.users || []) {
      token = await this.getAdminToken(baseUrl);
      const username = isGrafanaRealm ? this.grafanaAdminUsername : user.username;
      const password = user.password || defaultPassword;
      if (!password) {
        throw new Error(
          `No password for user '${username}' in realm '${realm.realm}'. Set defaultPassword or per-user password.`
        );
      }
      await this.createOrUpdateUserWithPassword(
        baseUrl,
        token,
        username,
        realm.realm,
        user.attributes || {},
        password,
        { firstName: user.firstName, lastName: user.lastName, email: user.email }
      );
    }

    this.log(`Standard realm '${realm.realm}' configured`, 'info');
  }

  async setupOrgRealm(baseUrl, token, realm) {
    this.log(`Setting up org realm '${realm.realm}' (orgId: ${realm.orgId})...`, 'info');
    await this.createNamedRealm(baseUrl, token, realm.realm);

    const orgAttrs = ['org_id', 'team_id', 'is_org_admin', 'is_team_admin'];
    await this.configureUserProfileForRealm(baseUrl, token, realm.realm, orgAttrs);

    const defaultPassword = realm.defaultPassword;

    for (const team of realm.teams || []) {
      token = await this.getAdminToken(baseUrl);
      const payload = {
        clientId: team.clientId,
        secret: team.clientSecret,
        enabled: true,
        publicClient: false,
        standardFlowEnabled: true,
        serviceAccountsEnabled: true,
        directAccessGrantsEnabled: true,
        redirectUris: ['*'],
        webOrigins: ['*'],
        attributes: {
          'post.logout.redirect.uris': '*',
          'access.token.signed.response.alg': 'RS256',
          'id.token.signed.response.alg': 'RS256',
        },
      };

      const result = await this.registerClient(baseUrl, token, payload, realm.realm);
      let id = this.extractIdFromLocation(result.stdout);
      if (!id) id = await this.lookupClientId(baseUrl, token, team.clientId, realm.realm);

      if (id) {
        const existingMapperNames = await this.listProtocolMapperNames(
          baseUrl,
          token,
          id,
          realm.realm
        );
        for (const attrName of orgAttrs) {
          if (existingMapperNames.has(attrName)) continue;
          await this.addAttributeMapper(baseUrl, token, id, realm.realm, attrName);
        }
        await this.setServiceAccountAttributes(baseUrl, token, id, realm.realm, {
          org_id: realm.orgId,
          team_id: team.teamId,
        });
      }

      for (const user of team.users || []) {
        const password = user.password || defaultPassword;
        if (!password) {
          throw new Error(
            `No password for user '${user.username}' in realm '${realm.realm}'. Set defaultPassword or per-user password.`
          );
        }
        await this.createOrUpdateUserWithPassword(
          baseUrl,
          token,
          user.username,
          realm.realm,
          user.attributes || {},
          password,
          { firstName: user.firstName, lastName: user.lastName, email: user.email }
        );
      }
    }

    this.log(`Org realm '${realm.realm}' configured`, 'info');
  }

  async setupRealms(baseUrl, token, realms) {
    this.log(`Setting up ${realms.length} realm(s) from config...`, 'info');
    for (const realm of realms) {
      // Refetch before each realm: a long-running realm (many clients/users) can
      // outlive the short-lived admin token issued for a previous realm.
      token = await this.getAdminToken(baseUrl);
      if (realm.teams) {
        await this.setupOrgRealm(baseUrl, token, realm);
      } else {
        await this.setupStandardRealm(baseUrl, token, realm);
      }
    }
  }

  async addGroupsClaimMapper(baseUrl, token, clientInternalId, realm = this.realm) {
    this.log('Adding Groups membership claim mapper...', 'info');
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${realm}/clients/${clientInternalId}/protocol-mappers/models`,
      token,
      {
        name: 'Groups',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-group-membership-mapper',
        config: {
          'claim.name': 'Groups',
          'full.path': 'false',
          'id.token.claim': 'true',
          'access.token.claim': 'true',
          'userinfo.token.claim': 'true',
        },
      }
    );
  }

  extractIdFromLocation(stdout) {
    if (!stdout) return null;
    const match = stdout.match(/[Ll]ocation:\s*.*\/clients\/([^\s\r\n]+)/);
    return match ? match[1] : null;
  }

  async lookupClientId(baseUrl, token, clientId, realm = this.realm) {
    try {
      const result = await CommandRunner.run(
        'curl',
        [
          '-sSfk',
          ...(this.curlResolveArgs || []),
          '-H',
          `Authorization: Bearer ${token}`,
          `${baseUrl}/admin/realms/${realm}/clients?clientId=${clientId}`,
        ],
        { ignoreError: true }
      );
      if (result.stdout) return JSON.parse(result.stdout)[0]?.id || null;
    } catch {
      /* fallthrough */
    }
    return null;
  }

  async createUsers(baseUrl, token) {
    this.log('Creating/updating users...', 'info');
    const users = [
      // Org admin for acme-corp - can manage all org/team budgets
      {
        username: 'acme-corp-admin',
        email: 'acme-corp@acme.com',
        firstName: 'Acme Org',
        lastName: 'Admin',
        attributes: {
          group: ['admins'],
          is_org_admin: ['true'],
          is_team_admin: ['false'],
          org_id: ['acme-corp'],
        },
      },
      // Team member of team-alpha under acme-corp
      {
        username: 'user1',
        email: 'user1@acme.com',
        firstName: 'Joe',
        lastName: 'Blogg',
        attributes: {
          group: ['users'],
          is_org_admin: ['false'],
          is_team_admin: ['false'],
          org_id: ['acme-corp'],
          team_id: ['team-alpha'],
        },
      },
      // Team member of team-alpha under acme-corp
      {
        username: 'user2',
        email: 'user2@acme.com',
        firstName: 'Bob',
        lastName: 'Doe',
        attributes: {
          group: ['users'],
          is_org_admin: ['false'],
          is_team_admin: ['false'],
          org_id: ['acme-corp'],
          team_id: ['team-alpha'],
        },
      },
      // Team member of team-alpha under acme-corp
      {
        username: 'team-alpha-admin',
        email: 'team-alpha@acme.com',
        firstName: 'Team Alpha',
        lastName: 'Admin',
        attributes: {
          group: ['users'],
          is_org_admin: ['false'],
          is_team_admin: ['true'],
          org_id: ['acme-corp'],
          team_id: ['team-alpha'],
        },
      },
      // Team member of team-beta under acme-corp
      {
        username: 'team-beta-admin',
        email: 'team-beta@acme.com',
        firstName: 'Team Beta',
        lastName: 'Admin',
        attributes: {
          group: ['users'],
          is_org_admin: ['false'],
          is_team_admin: ['true'],
          org_id: ['acme-corp'],
          team_id: ['team-beta'],
        },
      },
    ];
    for (const u of users) {
      await this.createOrUpdateUser(baseUrl, token, u);
    }
  }

  async createOrUpdateUser(baseUrl, token, user, realm = this.realm) {
    // Check if user already exists
    const existingId = await this.lookupUserId(baseUrl, token, user.username, realm);

    if (existingId) {
      // Update existing user's attributes
      this.log(`Updating user '${user.username}' attributes...`, 'info');
      await this.kcApi('PUT', `${baseUrl}/admin/realms/${realm}/users/${existingId}`, token, {
        ...user,
        enabled: true,
        emailVerified: true,
      });
    } else {
      // Create new user
      this.log(`Creating user '${user.username}'...`, 'info');
      await this.kcApi('POST', `${baseUrl}/admin/realms/${realm}/users`, token, {
        ...user,
        enabled: true,
        emailVerified: true,
        credentials: [{ type: 'password', value: 'Passwd00', temporary: false }],
      });
    }
  }

  async lookupUserId(baseUrl, token, username, realm = this.realm) {
    try {
      const result = await CommandRunner.run(
        'curl',
        [
          '-sSfk',
          ...(this.curlResolveArgs || []),
          '-H',
          `Authorization: Bearer ${token}`,
          `${baseUrl}/admin/realms/${realm}/users?username=${encodeURIComponent(username)}&exact=true`,
        ],
        { ignoreError: true }
      );
      if (result.stdout) {
        const users = JSON.parse(result.stdout);
        return users[0]?.id || null;
      }
    } catch {
      /* user not found */
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  async cleanup() {
    this.log('Cleaning up Keycloak...', 'info');
    const ns = this.keycloakNamespace;

    if (this.workloadClients.length > 0) {
      await this.cleanupWorkloadClients();
    }

    await this.deleteResource('deployment', 'keycloak', ns);
    await this.deleteResource('service', 'keycloak', ns);
    await this.deleteResource('secret', 'keycloak-secrets', ns);

    await this.deleteResource('deployment', 'postgres', ns);
    await this.deleteResource('service', 'postgres', ns);
    await this.deleteResource('secret', 'postgres-credentials', ns);
    await this.deleteResource('persistentvolumeclaim', 'postgres-pvc', ns);
    await this.deleteResource('serviceaccount', 'postgres', ns);

    if (this.tlsEnabled && this.createCertificate) {
      await this.deleteResource('certificate', this.tlsSecretName, ns);
      await this.deleteResource('secret', this.tlsSecretName, ns);
    }

    this.log('Keycloak cleaned up', 'success');
  }

  async cleanupWorkloadClients() {
    const baseUrl = `${this.protocol}://${this.hostname}`;
    let token;
    try {
      token = await this.getAdminToken(baseUrl);
    } catch (error) {
      this.log(
        `Could not obtain admin token for workload client cleanup: ${error.message}`,
        'warn'
      );
      return;
    }

    let k8sIdpRemoved = false;
    for (const client of this.workloadClients) {
      try {
        const id = await this.lookupClientId(baseUrl, token, client.clientId);
        if (id) {
          await this.kcApi('DELETE', `${baseUrl}/admin/realms/${this.realm}/clients/${id}`, token);
          this.log(`Workload client '${client.clientId}' deleted`, 'info');
        }
      } catch (error) {
        this.log(`Failed to delete workload client '${client.clientId}': ${error.message}`, 'warn');
      }

      if (client.configureTokenExchange && !k8sIdpRemoved) {
        try {
          await this.kcApi(
            'DELETE',
            `${baseUrl}/admin/realms/${this.realm}/identity-provider/instances/kubernetes`,
            token
          );
          this.log('Kubernetes IdP removed', 'info');
          k8sIdpRemoved = true;
        } catch (error) {
          this.log(`Failed to remove Kubernetes IdP: ${error.message}`, 'warn');
        }
      }

      if (client.k8sSecretName) {
        const secretNamespace = client.k8sSecretNamespace || FeatureManager.getDefaultNamespace();
        await this.deleteResource('secret', client.k8sSecretName, secretNamespace);
      }
    }
  }
}

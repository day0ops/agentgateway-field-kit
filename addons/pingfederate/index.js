import { Feature } from '../../src/lib/feature.js';
import {
  KubernetesHelper,
  CommandRunner,
  CertificateHelper,
  nlbSourceRangeAnnotations,
} from '../../src/lib/common.js';
import { spawn } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const CHART_REPO_NAME = 'pingidentity';
const CHART_REPO_URL = 'https://helm.pingidentity.com/';
const CHART_NAME = 'pingidentity/ping-devops';
const DEFAULT_PF_VERSION_TAG = '2610'; // PingFederate 13.1.4
const ADMIN_PORT = 9999;
const PORT_FORWARD_LOCAL_PORT = 19999;
const ATM_INSTANCE_ID = 'mcpJwtAtm';
const OAUTH_CLIENT_ID = 'agentgateway-mcp';

/**
 * PingFederate Feature (installed via Ping Identity's official ping-devops Helm chart)
 *
 * Deploys PingFederate (admin + engine, standard ping-devops topology) licensed via
 * the DevOps Program's evaluation license, then bootstraps the minimum OAuth AS
 * configuration agentgateway's MCP auth bridge needs via PingFederate's Admin REST
 * API (port-forwarded, since the admin Service is ClusterIP-only):
 *   - Accept the in-product license agreement (separate from EULA/container boot).
 *   - Access Token Manager: a JSON Web Tokens instance using PingFederate's
 *     centralized signing key, so agentgateway can validate tokens via the server's
 *     always-on /pf/JWKS endpoint rather than needing token introspection.
 *   - OAuth Client: a public/PKCE client (no secret), redirect URI matching the
 *     loopback callback mcp-eager-auth-pingfederate's browser-login test uses.
 *
 * This exists to validate a known agentgateway gap live: with no PingFederate
 * provider adapter, agentgateway doesn't rewrite the served discovery metadata's
 * registration_endpoint, so a client that follows the metadata hits PingFederate's
 * own Dynamic Client Registration endpoint (disabled by default) instead of
 * agentgateway's working mock-DCR short-circuit. See features/mcp-eager-auth-pingfederate.
 *
 * Requires PING_IDENTITY_DEVOPS_USER / PING_IDENTITY_DEVOPS_KEY (from Ping's DevOps
 * Program registration) so the chart's containers can fetch a 30-day eval license
 * automatically - no manual .lic upload.
 *
 * Known limitations (confirmed live, both unresolved): this devops/API-only bootstrap
 * path never runs PingFederate's first-time setup wizard, and two things that wizard
 * would normally set appear to stay stuck at their install-time defaults no matter
 * what's tried over the Admin API afterward (serverSettings, federationInfo,
 * PF_ENGINE_* env vars, virtualHostNames, full admin+engine restart sequencing):
 *   1. The server's own OAuth AS issuer stays hardcoded to https://localhost:9031.
 *   2. The runtime (engine) TLS listener keeps serving its own freshly regenerated
 *      self-signed cert for host "localhost", even after importing and activating a
 *      real certificate via /keyPairs/sslServer (see useTrustedEngineCertificate).
 * agentgateway's ad hoc IdP-metadata fetch (unlike JWKS fetching, which goes through a
 * Backend and can set insecureSkipVerify) always validates against the system CA
 * bundle with no override, so (2) blocks the actual discovery/DCR-facade reproduction
 * end-to-end until resolved - this is the one open item for whoever picks this up next.
 * `publicHostname` (optional) exposes the engine via a real LoadBalancer + DNS + Let's
 * Encrypt cert, as a path toward fixing (2); without it, `issuer` is the in-cluster
 * Service DNS name instead, which lets agentgateway reach PingFederate's metadata at
 * all (over the self-signed cert's Backend, where insecureSkipVerify does work) even
 * though neither form yet lets a real issued token validate past login.
 */
export class PingFederateFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.pfVersionTag = config.versionTag || DEFAULT_PF_VERSION_TAG;
    this.pfNamespace = config.namespace || 'pingfederate';
    this.adminPassword = process.env.PING_IDENTITY_PASSWORD || '2FederateM0re';
    this.devopsUser = process.env.PING_IDENTITY_DEVOPS_USER || '';
    this.devopsKey = process.env.PING_IDENTITY_DEVOPS_KEY || '';
    // Public hostname for the engine's LoadBalancer Service (external-dns + a real
    // cert-manager/Let's Encrypt cert) - required for agentgateway to trust the metadata
    // fetch: its ad hoc IdP-metadata HTTP client always validates against the system CA
    // bundle with no per-call override (confirmed in agentgateway's source), so a
    // self-signed cert fails there even where a Backend's insecureSkipVerify (used for
    // JWKS fetching) would otherwise cover it.
    this.publicHostname = config.publicHostname || null;
    // AWS NLB source-range restriction (same convention as the keycloak addon) - a no-op
    // annotation outside AWS/MetalLB-less clusters.
    this.sourceRanges = config.sourceRanges || null;
  }

  validate() {
    const missing = [
      !this.devopsUser && 'PING_IDENTITY_DEVOPS_USER',
      !this.devopsKey && 'PING_IDENTITY_DEVOPS_KEY',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(
        `PingFederate requires the following environment variable(s) to be set: ${missing.join(', ')}.\n` +
          'Register for the DevOps Program (https://developer.pingidentity.com/devops/how-to/devopsRegistration.html) to get these.'
      );
    }
    return true;
  }

  async deploy() {
    this.log('Installing PingFederate (ping-devops Helm chart)...', 'info');

    await KubernetesHelper.ensureNamespace(this.pfNamespace, this.spinner);
    await this.createDevopsSecret();
    if (this.publicHostname) {
      await this.createEngineCertificate();
    }
    await this.addHelmRepo();
    await this.installChart();
    await this.waitForPingFederate();

    await this.withAdminPortForward(async baseUrl => {
      await this.acceptLicenseAgreement(baseUrl);
      if (this.publicHostname) {
        await this.useTrustedEngineCertificate(baseUrl);
      }
      const atmId = await this.ensureJwtAccessTokenManager(baseUrl);
      await this.ensureOAuthClient(baseUrl, atmId);
    });

    this.log('PingFederate installed and bootstrapped', 'success');
    this.accessHint = `Admin console: kubectl port-forward -n ${this.pfNamespace} svc/pingfederate-pingfederate-admin ${ADMIN_PORT}:${ADMIN_PORT}, then https://localhost:${ADMIN_PORT}/pingfederate/app (Administrator / the password in PING_IDENTITY_PASSWORD)`;
  }

  // ---------------------------------------------------------------------------
  // License + Helm chart install
  // ---------------------------------------------------------------------------

  async createDevopsSecret() {
    this.log("Creating 'devops-secret' with DevOps Program license credentials...", 'info');
    await this.applyResource({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'devops-secret',
        namespace: this.pfNamespace,
        labels: this.labels,
      },
      type: 'Opaque',
      stringData: {
        PING_IDENTITY_DEVOPS_USER: this.devopsUser,
        PING_IDENTITY_DEVOPS_KEY: this.devopsKey,
        PING_IDENTITY_ACCEPT_EULA: 'YES',
      },
    });
  }

  async addHelmRepo() {
    this.log('Adding Ping Identity Helm repository...', 'info');
    await CommandRunner.run('helm', ['repo', 'add', CHART_REPO_NAME, CHART_REPO_URL], {
      ignoreError: true, // already added is fine
    });
    await CommandRunner.run('helm', ['repo', 'update']);
  }

  async installChart() {
    this.log('Installing PingFederate Helm chart (admin + engine)...', 'info');
    const args = [
      'upgrade',
      '-i',
      'pingfederate',
      CHART_NAME,
      '-n',
      this.pfNamespace,
      '--set',
      'pingfederate-admin.enabled=true',
      '--set',
      'pingfederate-engine.enabled=true',
      '--set',
      `pingfederate-admin.image.tag=${this.pfVersionTag}`,
      '--set',
      `pingfederate-engine.image.tag=${this.pfVersionTag}`,
      '--set',
      'global.license.secret.devOps=devops-secret',
      // 'envs' (plural), not 'env' - the singular key silently no-ops (confirmed live:
      // it never reaches the pod's env-vars ConfigMap at all).
      '--set',
      `pingfederate-admin.envs.PING_IDENTITY_PASSWORD=${this.adminPassword}`,
      // Without this, no admin account exists at all - every Admin API call except
      // /license/agreement 401s with invalid_credentials even after accepting the
      // license (confirmed live). --set-string, not --set - the ConfigMap's data
      // values must be strings and bare --set sends a YAML boolean (confirmed live:
      // server-side apply then rejects the whole upgrade).
      '--set-string',
      'pingfederate-admin.envs.CREATE_INITIAL_ADMIN_USER=true',
    ];

    if (this.publicHostname) {
      // Only the engine (runtime/OAuth traffic) is exposed - admin (console + Admin
      // API, where the credentials live) stays ClusterIP-only. This is the chart's
      // per-product 'services' override shape (confirmed via `helm show values`):
      // useLoadBalancerForDataService converts the dataService-marked port (https,
      // 9031) to a LoadBalancer; annotations attaches to that same Service.
      args.push('--set', 'pingfederate-engine.services.useLoadBalancerForDataService=true');
      const annotations = {
        'external-dns.kubernetes.io/hostname': this.publicHostname,
        ...nlbSourceRangeAnnotations(this.sourceRanges),
      };
      args.push(
        '--set-json',
        `pingfederate-engine.services.annotations=${JSON.stringify(annotations)}`
      );
    }

    args.push('--create-namespace', '--wait', '--timeout', '10m');
    await KubernetesHelper.helm(args);
  }

  async waitForPingFederate() {
    this.log('Waiting for PingFederate admin node to be ready...', 'info');
    await KubernetesHelper.cleanupAndWaitForDeployment(
      this.pfNamespace,
      'pingfederate-pingfederate-admin',
      'app.kubernetes.io/name=pingfederate-admin',
      600
    );
  }

  get engineTlsSecretName() {
    return `${this.pfNamespace}-engine-tls`;
  }

  /**
   * Issue a cert-manager Certificate for the public hostname, same pattern as the
   * keycloak addon (CertificateHelper.createCertificate -> Let's Encrypt for an
   * external hostname). agentgateway's ad hoc IdP-metadata fetch always validates
   * against the system CA bundle (see the class doc comment), so this has to be a
   * real publicly-trusted cert, not self-signed.
   */
  async createEngineCertificate() {
    this.log(`Issuing a certificate for '${this.publicHostname}'...`, 'info');
    const certificate = CertificateHelper.createCertificate({
      name: this.engineTlsSecretName,
      namespace: this.pfNamespace,
      hostname: this.publicHostname,
    });
    await this.applyResource(certificate);
    const ready = await CertificateHelper.waitForCertificate(
      this.pfNamespace,
      this.engineTlsSecretName,
      180,
      this.spinner
    );
    if (!ready) {
      this.log(`Certificate for '${this.publicHostname}' may not be fully ready yet`, 'warn');
    }
  }

  get labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
    };
  }

  // ---------------------------------------------------------------------------
  // Bootstrap via Admin API (port-forwarded - admin Service is ClusterIP-only)
  // ---------------------------------------------------------------------------

  async withAdminPortForward(fn) {
    const localPort = PORT_FORWARD_LOCAL_PORT;
    const pfProc = spawn(
      'kubectl',
      [
        ...KubernetesHelper.contextArgs(),
        'port-forward',
        '-n',
        this.pfNamespace,
        'svc/pingfederate-pingfederate-admin',
        `${localPort}:${ADMIN_PORT}`,
      ],
      { stdio: 'pipe' }
    );

    let stderrOutput = '';
    pfProc.stderr.on('data', data => {
      stderrOutput += data.toString();
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('PingFederate admin port-forward timed out')),
        15000
      );
      pfProc.stdout.on('data', data => {
        if (data.toString().includes('Forwarding from')) {
          clearTimeout(timer);
          resolve();
        }
      });
      pfProc.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      pfProc.on('close', code => {
        if (code !== null) {
          clearTimeout(timer);
          const detail = stderrOutput.trim() || `exit code ${code}`;
          reject(new Error(`PingFederate admin port-forward failed: ${detail}`));
        }
      });
    });

    try {
      return await fn(`https://localhost:${localPort}`);
    } finally {
      pfProc.kill();
      await new Promise(r => setTimeout(r, 100));
    }
  }

  /** Admin API calls - Basic Auth against the default 'Administrator' account. */
  async pfApi(method, path, body) {
    const args = [
      '-sSk',
      '-X',
      method,
      '-u',
      `Administrator:${this.adminPassword}`,
      '-H',
      'Content-Type: application/json',
      '-H',
      'X-XSRF-Header: PingFederate',
      '-w',
      '\n%{http_code}',
    ];
    if (body) args.push('-d', JSON.stringify(body));
    args.push(`https://localhost:${PORT_FORWARD_LOCAL_PORT}/pf-admin-api/v1${path}`);

    const result = await CommandRunner.run('curl', args, { ignoreError: true });
    const raw = result.stdout || '';
    const splitAt = raw.lastIndexOf('\n');
    const statusCode = parseInt(raw.slice(splitAt + 1).trim(), 10);
    const text = splitAt >= 0 ? raw.slice(0, splitAt) : '';
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body (e.g. 204 No Content) */
    }
    return { statusCode, json, raw: text };
  }

  /** Throws with the server's own error body surfaced, instead of a bare status code. */
  assertOk(response, context) {
    if (response.statusCode >= 200 && response.statusCode < 300) return;
    throw new Error(
      `PingFederate Admin API ${context} failed (HTTP ${response.statusCode}): ${response.raw || '<empty body>'}`
    );
  }

  /**
   * The DevOps image's PING_IDENTITY_ACCEPT_EULA env var controls whether the container
   * boots at all; it does not accept the in-product license agreement the Admin API
   * itself still gates on (confirmed live: every other endpoint 403s with
   * license_agreement_not_accepted until this call succeeds). Acceptance is tied to the
   * license itself, not pod-local state, so this is a no-op on already-accepted reruns
   * even though nothing else here survives a pod restart (no PVC backs this deployment).
   */
  async acceptLicenseAgreement(baseUrl) {
    this.log('Accepting the PingFederate license agreement...', 'info');
    const current = await this.pfApi('GET', '/license/agreement');
    this.assertOk(current, 'GET /license/agreement');
    if (current.json?.accepted) return;

    const accepted = await this.pfApi('PUT', '/license/agreement', { accepted: true });
    this.assertOk(accepted, 'PUT /license/agreement');
  }

  /**
   * Import the publicly-trusted cert-manager certificate and set it as the runtime
   * SSL server certificate, and register the public hostname as a recognized Virtual
   * Host Name (both steps per PingFederate's Admin API: POST
   * /keyPairs/sslServer/import, PUT /keyPairs/sslServer/settings, PUT
   * /virtualHostNames).
   *
   * Known limitation (confirmed live, unresolved): even after both calls succeed and
   * the engine is restarted, the runtime listener keeps serving its own freshly
   * regenerated self-signed cert for host "localhost" (visible in the engine's own
   * boot log: `RuntimeSslContextFactory` loads a cert id that changes every restart,
   * never the imported one) instead of picking the imported cert by SNI. This mirrors
   * the issuer-string limitation in the class doc comment - something in this
   * devops/API-only bootstrap path (no setup wizard ever ran) isn't wiring runtime TLS
   * identity the way a GUI-driven install would. Left in as a non-fatal best-effort
   * step (the import/activation themselves do succeed) for whoever picks this up next;
   * logs a warning rather than failing the whole deploy.
   */
  async useTrustedEngineCertificate(baseUrl) {
    this.log(`Importing certificate for '${this.publicHostname}' into PingFederate...`, 'info');
    const tmpDir = await mkdtemp(join(tmpdir(), 'pf-cert-'));
    try {
      const crtPath = join(tmpDir, 'tls.crt');
      const keyPath = join(tmpDir, 'tls.key');
      const p12Path = join(tmpDir, 'bundle.p12');
      const p12Password = 'changeit';

      await this.exportTlsSecretFiles(crtPath, keyPath);
      const pkcs12 = await CommandRunner.run(
        'openssl',
        [
          'pkcs12',
          '-export',
          '-out',
          p12Path,
          '-inkey',
          keyPath,
          '-in',
          crtPath,
          '-name',
          'pingfederate-engine',
          '-passout',
          `pass:${p12Password}`,
        ],
        { ignoreError: true }
      );
      if (pkcs12.exitCode !== 0) {
        this.log(
          `Could not build a PKCS12 bundle from the issued certificate: ${pkcs12.stderr || pkcs12.message}`,
          'warn'
        );
        return;
      }

      const fileData = (await readFile(p12Path)).toString('base64');
      const imported = await this.pfApi('POST', '/keyPairs/sslServer/import', {
        fileData,
        password: p12Password,
      });
      if (imported.statusCode < 200 || imported.statusCode >= 300) {
        this.log(`Certificate import failed: ${imported.raw}`, 'warn');
        return;
      }

      const current = await this.pfApi('GET', '/keyPairs/sslServer/settings');
      const updated = await this.pfApi('PUT', '/keyPairs/sslServer/settings', {
        ...current.json,
        runtimeServerCertRef: { id: imported.json.id },
        activeRuntimeServerCerts: [{ id: imported.json.id }],
      });
      if (updated.statusCode < 200 || updated.statusCode >= 300) {
        this.log(`Activating the imported certificate failed: ${updated.raw}`, 'warn');
      }

      const vhosts = await this.pfApi('PUT', '/virtualHostNames', {
        virtualHostNames: [this.publicHostname],
      });
      if (vhosts.statusCode < 200 || vhosts.statusCode >= 300) {
        this.log(`Registering the virtual host name failed: ${vhosts.raw}`, 'warn');
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  /** Reads the cert-manager-issued Secret's tls.crt/tls.key out to local files. */
  async exportTlsSecretFiles(crtPath, keyPath) {
    const crt = await KubernetesHelper.kubectl([
      'get',
      'secret',
      this.engineTlsSecretName,
      '-n',
      this.pfNamespace,
      '-o',
      'jsonpath={.data.tls\\.crt}',
    ]);
    const key = await KubernetesHelper.kubectl([
      'get',
      'secret',
      this.engineTlsSecretName,
      '-n',
      this.pfNamespace,
      '-o',
      'jsonpath={.data.tls\\.key}',
    ]);
    const { writeFile } = await import('fs/promises');
    await writeFile(crtPath, Buffer.from(crt.stdout.trim(), 'base64'));
    await writeFile(keyPath, Buffer.from(key.stdout.trim(), 'base64'));
  }

  /**
   * Create (or reuse) a JSON Web Tokens Access Token Manager, so agentgateway can
   * validate MCP access tokens via JWKS rather than PingFederate's introspection
   * endpoint. The JWT plugin's descriptor is fetched live rather than assuming field
   * names, since ATM configuration is plugin-defined and version-specific.
   *
   * Uses "Use Centralized Signing Key" rather than a per-ATM signing certificate:
   * generating a dedicated signing key pair (`/keyPairs/signing/generate`) produced a
   * cert this plugin's "Active Signing Certificate Key ID" field never accepted
   * (confirmed live, option list stayed empty regardless of id/fingerprint/serial
   * tried), and that field is also the only way to enable "Publish Keys to the
   * PingFederate JWKS Endpoint". The centralized-signing path skips both: PingFederate
   * always serves its own default signing keys at /pf/JWKS regardless of this ATM's
   * config (confirmed live), so no per-ATM JWKS publishing is needed at all.
   */
  async ensureJwtAccessTokenManager(baseUrl) {
    const existing = await this.pfApi('GET', `/oauth/accessTokenManagers/${ATM_INSTANCE_ID}`);
    if (existing.statusCode === 200) {
      this.log(`Reusing existing Access Token Manager '${ATM_INSTANCE_ID}'`, 'info');
      return ATM_INSTANCE_ID;
    }

    this.log('Looking up the JSON Web Tokens Access Token Manager plugin descriptor...', 'info');
    const descriptors = await this.pfApi('GET', '/oauth/accessTokenManagers/descriptors');
    this.assertOk(descriptors, 'GET /oauth/accessTokenManagers/descriptors');

    const jwtDescriptor = (descriptors.json?.items || []).find(d =>
      /json\s*web\s*tokens/i.test(d.name || '')
    );
    if (!jwtDescriptor) {
      throw new Error(
        `Could not find a 'JSON Web Tokens' Access Token Manager plugin descriptor. ` +
          `Available: ${(descriptors.json?.items || []).map(d => d.name).join(', ')}`
      );
    }

    const overrides = {
      'Use Centralized Signing Key': 'true',
      'JWS Algorithm': 'RS256',
      'Audience Claim Value': OAUTH_CLIENT_ID,
    };
    const descriptorFields = jwtDescriptor.configDescriptor?.fields || [];
    const descriptorFieldNames = new Set(descriptorFields.map(f => f.name));
    const unmatchedOverrides = Object.keys(overrides).filter(
      name => !descriptorFieldNames.has(name)
    );
    if (descriptorFields.length < 10 || unmatchedOverrides.length > 0) {
      // Fail loud here with the raw response rather than let a near-empty field set
      // through to PingFederate, where it surfaces later as a much more cryptic error
      // (e.g. "Please provide integrity protection with a JWS Algorithm...") with no
      // indication the real cause was a malformed/incomplete descriptor fetch.
      throw new Error(
        `JSON Web Tokens ATM descriptor looks incomplete (${descriptorFields.length} fields, ` +
          `missing: ${unmatchedOverrides.join(', ') || 'none'}). Raw descriptor fetch: ${descriptors.raw}`
      );
    }
    const fields = descriptorFields.map(f => ({
      name: f.name,
      value: overrides[f.name] ?? f.defaultValue ?? f.value ?? '',
    }));

    this.log(`Creating Access Token Manager '${ATM_INSTANCE_ID}' (JSON Web Tokens)...`, 'info');
    const created = await this.pfApi('POST', '/oauth/accessTokenManagers', {
      id: ATM_INSTANCE_ID,
      name: 'MCP JWT Access Token Manager',
      pluginDescriptorRef: { id: jwtDescriptor.id },
      configuration: { fields, tables: [] },
      // extendedAttributes only - this plugin's own attributeContract is empty (no
      // built-in coreAttributes), and submitting a coreAttributes key of our own
      // ("sub") was rejected as "attribute contract cannot be empty" (confirmed live).
      attributeContract: { extendedAttributes: [{ name: 'sub' }] },
    });
    this.assertOk(created, 'POST /oauth/accessTokenManagers');
    return ATM_INSTANCE_ID;
  }

  async ensureOAuthClient(baseUrl, atmId) {
    const existing = await this.pfApi('GET', `/oauth/clients/${OAUTH_CLIENT_ID}`);
    if (existing.statusCode === 200) {
      this.log(`Reusing existing OAuth client '${OAUTH_CLIENT_ID}'`, 'info');
      return;
    }

    this.log(`Creating public/PKCE OAuth client '${OAUTH_CLIENT_ID}'...`, 'info');
    const created = await this.pfApi('POST', '/oauth/clients', {
      clientId: OAUTH_CLIENT_ID,
      name: 'agentgateway MCP eager-auth',
      enabled: true,
      grantTypes: ['AUTHORIZATION_CODE'],
      redirectUris: ['http://localhost:8766/callback'],
      // Public client, no secret - confirmed live default (clientAuth.type: "NONE")
      // when omitted; PKCE is a separate top-level field, not nested under clientAuth.
      requireProofKeyForCodeExchange: true,
      defaultAccessTokenManagerRef: { id: atmId },
      restrictScopes: false,
      bypassApprovalPage: true,
    });
    this.assertOk(created, 'POST /oauth/clients');
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  async cleanup() {
    this.log('Cleaning up PingFederate...', 'info');
    await KubernetesHelper.helm(['uninstall', 'pingfederate', '-n', this.pfNamespace], {
      ignoreError: true, // release may not exist
    });
    await this.deleteResource('secret', 'devops-secret', this.pfNamespace);
    this.log('PingFederate cleaned up', 'success');
  }
}

import { Feature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';
import { TokenExchangeFeature } from '../token-exchange/index.js';
import { OauthIssuerRouteFeature } from '../oauth-issuer-route/index.js';
import { EDITION_GATEWAY_NAME, BACKEND_API_GROUP, BACKEND_KIND } from '../../src/lib/editions.js';

// Keycloak's default audience for tokens without a custom audience mapper - live-verified
// against this cluster (a password-grant token via agw-client carries aud: "account").
const DEFAULT_AUDIENCES = ['account'];

/**
 * Auth-Only MCP Feature
 *
 * Fronts an MCP backend with the gateway controller's own OAuth issuer, exactly like
 * mcp-eager-auth-okta/mcp-eager-auth-auth0, but federating with Keycloak (this repo's
 * own IdP) as the downstream provider instead of a third-party one. The controller runs
 * its own OAuth authorization server on port 7777; MCP clients log in against it before
 * any tool call reaches the backend. No per-user upstream token exchange happens - this
 * is auth-only, not token exchange (see docs/mcp/token-exchange/auth-only/).
 *
 * Unlike Okta/Auth0, Keycloak's real Dynamic Client Registration endpoint is reachable
 * once its default registration policies are relaxed (the same admin-API step mcp-auth's
 * configureDynamicRegistration already performs for its own, unrelated flow) - so this
 * feature does NOT set `clientId` on the mcp auth extension: the controller proxies real
 * DCR to Keycloak instead of short-circuiting with a mock response.
 *
 * MCP auth itself is configured via `traffic.jwtAuthentication` + its `mcp` extension
 * field, targeting the HTTPRoute - the same route-level shape used throughout this repo.
 *
 * This performs a real Helm upgrade on the shared enterprise-agentgateway release (via
 * the token-exchange feature) - the controller pod restarts. Cleanup leaves
 * KGW_OAUTH_ISSUER_CONFIG in place (same rationale as mcp-eager-auth-okta) but does tear
 * down the oauth-issuer route (see oauth-issuer-route) - this is currently this repo's
 * only consumer of that route, so there's no other usecase left depending on it.
 *
 * Keycloak's KC_HOSTNAME (and its cert's SAN) is the external hostname configured on the
 * keycloak addon, not the in-cluster Service DNS name - real tokens carry
 * iss = <externalUrl>/realms/<realm>, and only the external hostname verifies cleanly over
 * TLS. Without `keycloak.externalUrl` set, the JWKS fetch to the in-cluster Service DNS name
 * fails cert hostname verification (x509.HostnameError) every retry, the controller silently
 * drops that JWT provider when building the data-plane config, and the proxy then rejects the
 * policy with "JWT MCP extension requires exactly one provider, found 0" - live-diagnosed via
 * controller logs (component: jwks_store). Same root cause and fix as mcp-auth's own
 * keycloakExternalUrl. Set `keycloak.externalUrl` (e.g. '{{env.keycloak.scheme}}://{{env.domains.keycloak}}')
 * for a real deploy.
 *
 * Configuration:
 * {
 *   name: string,               // Resource name prefix (default: 'auth-only-mcp')
 *   keycloak: {
 *     realm: string,             // Default: 'agw-dev'
 *     externalUrl: string,       // Keycloak's public base URL, e.g. 'https://keycloak.example.com' -
 *                                // required for a real deploy (see note above); omit only for
 *                                // dry-run/unit tests, where the in-cluster host + insecureSkipVerify
 *                                // is used instead
 *     serviceName: string,       // Default: 'keycloak'
 *     serviceNamespace: string,  // Default: 'keycloak'
 *     servicePort: number,       // Default: 443
 *     configureDynamicRegistration: bool, // Remove registration policies (default: true) - needs
 *                                         // KEYCLOAK_ADMIN_USERNAME / KEYCLOAK_ADMIN_PASSWORD env vars
 *   },
 *   clientId: string,           // Keycloak client ID for the controller's OAuth issuer (default: 'agw-issuer')
 *   clientSecret: string,       // Or clientSecretEnvVar
 *   clientSecretEnvVar: string, // Env var holding the client secret
 *   audiences: string[],        // Expected token audiences (default: ['account'])
 *   gatewayName: string,        // Gateway to fetch the public LB address from (default: edition default)
 *   gatewayPort: number,        // Gateway port for the OAuth issuer base_url (default: 8080)
 *   gatewayBaseUrl: string,     // Override auto-detected 'http://<lb-address>:<port>'
 *   mcpPath: string,            // Path suffix for resourceMetadata.resource (default: '/')
 *   routeName: string,          // HTTPRoute created by the mcp-server feature, targeted by the
 *                               // JWT auth policy (default: 'mcp')
 *   postgres: { image: string, port: number },
 *   preIssuance: {              // Gate the controller's OAuth issuer with an ext_authz check
 *                               // before it mints a token (default: disabled). Schema confirmed
 *                               // against solo-io/agentgateway-enterprise#6356 - see
 *                               // deployPreIssuanceExtAuthz() below.
 *     enabled: boolean,          // Default: false
 *     allowedPrincipals: string[], // Principals allowed through the pre-issuance gate (required
 *                                  // when enabled)
 *     deniedRedirect: string,   // URL the controller redirects denied logins to (required when
 *                               // enabled - the controller's pre_issuance.denied_redirect is
 *                               // mandatory)
 *     extAuthz: {
 *       serviceName: string,     // Default: '<prefix>-preissuance-authz'
 *       namespace: string,       // Default: same namespace as this feature
 *       port: number,            // Default: 9002
 *       image: string,           // Default: GAR preissuance-ext-authz:0.1.0
 *     },
 *   },
 * }
 */
export class AuthOnlyMcpFeature extends Feature {
  static SUPPORTED_EDITIONS = ['enterprise'];

  get prefix() {
    return this.config.name || 'auth-only-mcp';
  }

  get keycloak() {
    return this.config.keycloak || {};
  }

  get realm() {
    return this.keycloak.realm || 'agw-dev';
  }

  get keycloakServiceName() {
    return this.keycloak.serviceName || 'keycloak';
  }

  get keycloakServiceNamespace() {
    return this.keycloak.serviceNamespace || 'keycloak';
  }

  get keycloakServicePort() {
    return this.keycloak.servicePort || 443;
  }

  get keycloakProtocol() {
    return this.keycloakServicePort === 443 || this.keycloakServicePort === 8443 ? 'https' : 'http';
  }

  get keycloakHost() {
    return `${this.keycloakServiceName}.${this.keycloakServiceNamespace}.svc.cluster.local`;
  }

  get keycloakExternalUrl() {
    return this.keycloak.externalUrl || null;
  }

  // Keycloak's KC_HOSTNAME (and its cert's SAN) is the external hostname, not the in-cluster
  // Service DNS name - real tokens carry iss = <externalUrl>/realms/<realm>, and only the
  // external hostname verifies cleanly over TLS. Same fix as mcp-auth's keycloakExternalUrl.
  get keycloakBaseUrl() {
    return this.keycloakExternalUrl || `${this.keycloakProtocol}://${this.keycloakHost}`;
  }

  get configureDynamicRegistration() {
    return this.keycloak.configureDynamicRegistration !== false;
  }

  get adminUsername() {
    return process.env.KEYCLOAK_ADMIN_USERNAME || '';
  }

  get adminPassword() {
    return process.env.KEYCLOAK_ADMIN_PASSWORD || '';
  }

  get clientId() {
    return this.config.clientId || 'agw-issuer';
  }

  get clientSecret() {
    return (
      this.config.clientSecret ||
      process.env[this.config.clientSecretEnvVar || ''] ||
      // Keycloak is this repo's own IdP - its demo client secrets are already checked
      // into config/profiles/*.yaml in plaintext, unlike third-party IdP secrets.
      'agw-issuer-secret'
    );
  }

  get audiences() {
    return this.config.audiences || DEFAULT_AUDIENCES;
  }

  get gatewayName() {
    return this.config.gatewayName || EDITION_GATEWAY_NAME[this.edition];
  }

  get gatewayPort() {
    return this.config.gatewayPort || 8080;
  }

  get mcpPath() {
    return this.config.mcpPath || '/';
  }

  get routeName() {
    return this.config.routeName || 'mcp';
  }

  get postgresImage() {
    return this.config.postgres?.image || 'postgres:18-alpine';
  }

  get postgresPort() {
    return this.config.postgres?.port || 5432;
  }

  get labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
    };
  }

  get postgresServiceHost() {
    return `${this.prefix}-postgres.${this.namespace}.svc.cluster.local`;
  }

  get preIssuance() {
    return this.config.preIssuance || {};
  }

  get preIssuanceEnabled() {
    return this.preIssuance.enabled === true;
  }

  get preIssuanceAllowedPrincipals() {
    return this.preIssuance.allowedPrincipals || [];
  }

  get preIssuanceDeniedRedirect() {
    return this.preIssuance.deniedRedirect || null;
  }

  get preIssuanceExtAuthzName() {
    return this.preIssuance.extAuthz?.serviceName || `${this.prefix}-preissuance-authz`;
  }

  get preIssuanceExtAuthzNamespace() {
    return this.preIssuance.extAuthz?.namespace || this.namespace;
  }

  get preIssuanceExtAuthzPort() {
    return this.preIssuance.extAuthz?.port || 9002;
  }

  get preIssuanceExtAuthzImage() {
    return (
      this.preIssuance.extAuthz?.image ||
      'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/preissuance-ext-authz:0.1.0'
    );
  }

  validate() {
    if (this.preIssuanceEnabled && this.preIssuanceAllowedPrincipals.length === 0) {
      throw new Error(
        'auth-only-mcp preIssuance.enabled requires at least one preIssuance.allowedPrincipals entry'
      );
    }
    if (this.preIssuanceEnabled && !this.preIssuanceDeniedRedirect) {
      throw new Error(
        'auth-only-mcp preIssuance.enabled requires preIssuance.deniedRedirect (required by the ' +
          "controller's pre_issuance schema - see solo-io/agentgateway-enterprise#6356)"
      );
    }
    return true;
  }

  async deploy() {
    // Without externalUrl, issuer/JWKS validation falls back to the in-cluster Service DNS
    // name, which never matches a real token's iss claim or Keycloak's cert SAN - fine for
    // dry-run/unit tests, silently broken for a real deploy (see keycloakBaseUrl).
    if (!this.dryRun && !this.keycloakExternalUrl) {
      throw new Error(
        'auth-only-mcp requires keycloak.externalUrl for a real deploy (e.g. ' +
          "'{{env.keycloak.scheme}}://{{env.domains.keycloak}}')"
      );
    }

    this.log('Deploying auth-only MCP (Keycloak) infrastructure...', 'info');

    await this.deployPostgres();
    if (this.preIssuanceEnabled) {
      await this.deployPreIssuanceExtAuthz();
    }
    await this.deployTokenExchange();
    if (this.configureDynamicRegistration && !this.dryRun) {
      await this.configureKeycloakDynamicRegistration();
    }
    await this.deployOAuthIssuerRoute();
    await this.deployKeycloakJwksBackend();
    await this.deployMcpAuthPolicy();
    if (this.preIssuanceEnabled) {
      await this.deployResourceIndexPolicy();
    }

    this.log('Auth-only MCP (Keycloak) deployed', 'success');
  }

  async deployPostgres() {
    const name = `${this.prefix}-postgres`;

    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, namespace: this.namespace, labels: this.labels },
      type: 'Opaque',
      stringData: {
        POSTGRES_USER: 'tokenexchange',
        POSTGRES_PASSWORD: 'tokenexchange',
        POSTGRES_DB: 'tokenexchange',
      },
    };
    await this.applyResource(secret);

    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: this.namespace, labels: { ...this.labels, app: name } },
      spec: {
        selector: { app: name },
        ports: [{ port: this.postgresPort, targetPort: this.postgresPort, name: 'postgres' }],
      },
    };
    await this.applyResource(service);

    const pvc = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name, namespace: this.namespace, labels: this.labels },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: '5Gi' } },
      },
    };
    await this.applyResource(pvc);

    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: this.namespace, labels: { ...this.labels, app: name } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            containers: [
              {
                name: 'postgres',
                image: this.postgresImage,
                ports: [{ containerPort: this.postgresPort }],
                envFrom: [{ secretRef: { name } }],
                volumeMounts: [{ name: 'data', mountPath: '/var/lib/postgresql' }],
                readinessProbe: {
                  exec: { command: ['pg_isready', '-U', 'tokenexchange'] },
                  initialDelaySeconds: 5,
                  periodSeconds: 5,
                },
              },
            ],
            volumes: [{ name: 'data', persistentVolumeClaim: { claimName: name } }],
          },
        },
      },
    };
    await this.applyResource(deployment);
    this.log(`Postgres '${name}' deployed for the token-exchange controller`, 'info');
  }

  // pre_issuance schema confirmed against the merged controller PR (solo-io/
  // agentgateway-enterprise#6356, "Add Pre Issuance OAuth flow hook"): flat
  // pre_issuance.grpc.target (not a nested ext_authz.grpc_service.target_uri), requires
  // enabled: true, and denied_redirect is required. source.principal carries the
  // downstream IdP's user_id (Keycloak, here) per that PR's documented request shape.
  // insecure_disable_tls: true is required since this feature's ext_authz service (like
  // this repo's other ext_authz adapters - opa-ext-authz, openfga-ext-authz) speaks
  // plaintext gRPC, and the controller defaults to requiring TLS on this connection.
  // CheckRequest.Attributes.Source.Principal carries Keycloak's internal user ID (the
  // `sub` claim, a UUID) rather than the username - live-confirmed against this cluster's
  // controller. Keycloak assigns that ID at user-creation time with no fixed/predictable
  // value (this repo's keycloak addon creates users via the Admin API without pinning an
  // id), so preIssuance.allowedPrincipals is authored as friendly usernames and resolved
  // to live Keycloak user IDs here - matching the demo-authoring convention
  // solo-io/solo-field-installer's own eager-oauth-auth0-multiplexed-with-unauth README
  // documents for Auth0 (look up each user's real `sub`, not their login name).
  async resolveAllowedPrincipalIds() {
    if (this.dryRun) {
      return this.preIssuanceAllowedPrincipals;
    }

    const useDirectCurl = !!this.keycloakExternalUrl;
    const runCurl = curlCmd =>
      useDirectCurl
        ? CommandRunner.exec(curlCmd, { ignoreError: true })
        : CommandRunner.run(
            'kubectl',
            [
              '-n',
              this.keycloakServiceNamespace,
              'exec',
              'deploy/keycloak',
              '--',
              'bash',
              '-c',
              curlCmd,
            ],
            { ignoreError: true }
          );

    const adminUser = encodeURIComponent(this.adminUsername).replace(/'/g, '%27');
    const adminPass = encodeURIComponent(this.adminPassword).replace(/'/g, '%27');

    let token;
    try {
      const result = await runCurl(
        `curl -sSfk -X POST ${this.keycloakBaseUrl}/realms/master/protocol/openid-connect/token ` +
          `-H 'Content-Type: application/x-www-form-urlencoded' ` +
          `-d 'username=${adminUser}&password=${adminPass}&grant_type=password&client_id=admin-cli'`
      );
      if (result.stdout) {
        token = JSON.parse(result.stdout).access_token;
      }
    } catch {
      // handled below
    }

    if (!token) {
      this.log(
        'Could not obtain Keycloak admin token to resolve preIssuance.allowedPrincipals - ' +
          'passing configured values through as-is (source.principal is a Keycloak user ID, ' +
          'not a username, so this will likely deny every login)',
        'warn'
      );
      return this.preIssuanceAllowedPrincipals;
    }

    const resolved = [];
    for (const username of this.preIssuanceAllowedPrincipals) {
      try {
        const result = await runCurl(
          `curl -sSfk -H 'Authorization: Bearer ${token}' ` +
            `'${this.keycloakBaseUrl}/admin/realms/${this.realm}/users?username=${encodeURIComponent(username)}'`
        );
        const users = JSON.parse(result.stdout || '[]');
        const match = users.find(u => u.username === username);
        if (match?.id) {
          resolved.push(match.id);
        } else {
          throw new Error('not found');
        }
      } catch {
        this.log(
          `Could not resolve Keycloak user id for '${username}' - passing through as-is`,
          'warn'
        );
        resolved.push(username);
      }
    }
    return resolved;
  }

  async deployPreIssuanceExtAuthz() {
    const name = this.preIssuanceExtAuthzName;
    const ns = this.preIssuanceExtAuthzNamespace;
    const allowedPrincipalIds = await this.resolveAllowedPrincipalIds();

    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: ns, labels: { ...this.labels, app: name } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            containers: [
              {
                name: 'preissuance-authz',
                image: this.preIssuanceExtAuthzImage,
                ports: [{ containerPort: this.preIssuanceExtAuthzPort, name: 'grpc' }],
                env: [
                  { name: 'PORT', value: String(this.preIssuanceExtAuthzPort) },
                  {
                    name: 'ALLOWED_PRINCIPALS',
                    value: allowedPrincipalIds.join(','),
                  },
                ],
              },
            ],
          },
        },
      },
    };
    await this.applyResource(deployment);

    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: ns, labels: this.labels },
      spec: {
        selector: { app: name },
        ports: [
          {
            port: this.preIssuanceExtAuthzPort,
            targetPort: this.preIssuanceExtAuthzPort,
            name: 'grpc',
          },
        ],
      },
    };
    await this.applyResource(service);

    this.log(
      `Pre-issuance ext_authz service '${name}' deployed (image: ${this.preIssuanceExtAuthzImage})`,
      'info'
    );
  }

  async deployTokenExchange() {
    const baseUrl = await this.resolveGatewayBaseUrl();

    const oauthIssuerConfig = {
      downstream_server: {
        name: 'keycloak',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        authorize_url: `${this.keycloakBaseUrl}/realms/${this.realm}/protocol/openid-connect/auth`,
        token_url: `${this.keycloakBaseUrl}/realms/${this.realm}/protocol/openid-connect/token`,
        scopes: ['openid', 'profile'],
      },
      gateway_config: {
        base_url: `${baseUrl}/oauth-issuer`,
      },
      par_config: { enabled: true },
    };

    if (this.preIssuanceEnabled) {
      oauthIssuerConfig.pre_issuance = {
        enabled: true,
        grpc: {
          target: `${this.preIssuanceExtAuthzName}.${this.preIssuanceExtAuthzNamespace}.svc.cluster.local:${this.preIssuanceExtAuthzPort}`,
          insecure_disable_tls: true,
        },
        denied_redirect: this.preIssuanceDeniedRedirect,
      };
    }

    const tokenExchange = new TokenExchangeFeature(this.name, {
      namespace: this.namespace,
      database: {
        postgres: {
          url: `postgres://tokenexchange:tokenexchange@${this.postgresServiceHost}:${this.postgresPort}/tokenexchange?sslmode=disable`,
        },
      },
      oauthIssuerConfig,
    });
    tokenExchange.setSpinner(this.spinner);
    tokenExchange.adoptParentContext(this);
    await tokenExchange.deploy();
  }

  async resolveGatewayBaseUrl() {
    if (this.config.gatewayBaseUrl) return this.config.gatewayBaseUrl;
    if (this.dryRun) return 'http://<gateway-address>:8080';

    const address = await KubernetesHelper.getLoadBalancerAddress(
      this.namespace,
      this.gatewayName,
      120
    );
    return `http://${address}:${this.gatewayPort}`;
  }

  async deployOAuthIssuerRoute() {
    const oauthIssuerRoute = new OauthIssuerRouteFeature(this.name, {
      namespace: this.namespace,
      gatewayName: this.gatewayName,
    });
    oauthIssuerRoute.setSpinner(this.spinner);
    oauthIssuerRoute.adoptParentContext(this);
    await oauthIssuerRoute.deploy();
  }

  // Reopens Keycloak's real DCR endpoint the same way mcp-auth's own
  // configureDynamicRegistration does, for the same underlying reason: by default,
  // Keycloak's client-registration policies reject anonymous registration. Duplicated
  // rather than shared - see mcp-auth's own deployBackendTlsPolicy() for the same
  // small-infra-boilerplate-duplication precedent already established in this repo.
  //
  // Runs curl directly from the CLI host (useDirectCurl) rather than via `kubectl exec`
  // into the Keycloak pod whenever an external URL is configured: the pinned Keycloak
  // image has no curl (or any shell utilities) installed, so `kubectl exec ... curl`
  // always fails there. Same fix as mcp-auth's own configureKeycloakDynamicRegistration.
  async configureKeycloakDynamicRegistration() {
    this.log('Configuring Keycloak for dynamic client registration...', 'info');

    const useDirectCurl = !!this.keycloakExternalUrl;
    // encodeURIComponent leaves ' unescaped, which would break out of the -d '...'
    // shell quoting below, so it's stripped separately.
    const username = encodeURIComponent(this.adminUsername).replace(/'/g, '%27');
    const password = encodeURIComponent(this.adminPassword).replace(/'/g, '%27');

    let token;
    try {
      const result = useDirectCurl
        ? await CommandRunner.exec(
            `curl -sSfk -X POST ${this.keycloakBaseUrl}/realms/master/protocol/openid-connect/token ` +
              `-H 'Content-Type: application/x-www-form-urlencoded' ` +
              `-d 'username=${username}&password=${password}&grant_type=password&client_id=admin-cli'`,
            { ignoreError: true }
          )
        : await CommandRunner.run(
            'kubectl',
            [
              '-n',
              this.keycloakServiceNamespace,
              'exec',
              'deploy/keycloak',
              '--',
              'bash',
              '-c',
              `curl -sSfk -X POST ${this.keycloakBaseUrl}/realms/master/protocol/openid-connect/token ` +
                `-H 'Content-Type: application/x-www-form-urlencoded' ` +
                `-d 'username=${username}&password=${password}&grant_type=password&client_id=admin-cli'`,
            ],
            { ignoreError: true }
          );
      if (result.stdout) {
        token = JSON.parse(result.stdout).access_token;
      }
    } catch {
      this.log('Could not obtain Keycloak admin token for dynamic registration setup', 'warn');
      return;
    }

    if (!token) {
      this.log(
        'Could not obtain Keycloak admin token, skipping dynamic registration config',
        'warn'
      );
      return;
    }

    await this.removeRegistrationPolicy(token, 'trusted-hosts', null, useDirectCurl);
    await this.removeRegistrationPolicy(
      token,
      'allowed-client-templates',
      'anonymous',
      useDirectCurl
    );

    this.log('Keycloak dynamic client registration configured', 'info');
  }

  async removeRegistrationPolicy(token, providerId, subType, useDirectCurl = false) {
    const runCurl = curlCmd =>
      useDirectCurl
        ? CommandRunner.exec(curlCmd, { ignoreError: true })
        : CommandRunner.run(
            'kubectl',
            [
              '-n',
              this.keycloakServiceNamespace,
              'exec',
              'deploy/keycloak',
              '--',
              'bash',
              '-c',
              curlCmd,
            ],
            { ignoreError: true }
          );

    try {
      const listResult = await runCurl(
        `curl -sSfk -H 'Authorization: Bearer ${token}' ` +
          `'${this.keycloakBaseUrl}/admin/realms/${this.realm}/components?type=org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy'`
      );
      if (!listResult.stdout) return;

      const policies = JSON.parse(listResult.stdout);
      const match = policies.find(p => {
        if (p.providerId !== providerId) return false;
        if (subType && p.subType !== subType) return false;
        return true;
      });
      if (!match) return;

      await runCurl(
        `curl -sSfk -X DELETE -H 'Authorization: Bearer ${token}' ` +
          `'${this.keycloakBaseUrl}/admin/realms/${this.realm}/components/${match.id}'`
      );
      this.log(`Removed Keycloak registration policy '${providerId}'`, 'info');
    } catch {
      this.log(`Could not remove Keycloak registration policy '${providerId}'`, 'warn');
    }
  }

  async deployKeycloakJwksBackend() {
    // Prefer dialing the external hostname directly (same domain as keycloakBaseUrl) - its
    // cert (cert-manager/Let's Encrypt) is only valid for that SAN, so connecting via the
    // in-cluster Service DNS name fails hostname verification (x509.HostnameError, confirmed
    // live) even with a matching SNI. Falls back to the in-cluster host with insecureSkipVerify
    // when no externalUrl is configured (e.g. plain unit-test/dry-run deploys).
    const jwksHost = this.keycloakExternalUrl
      ? new URL(this.keycloakExternalUrl).hostname
      : this.keycloakHost;

    const backend = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: `${this.prefix}-jwks`,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        static: { host: jwksHost, port: this.keycloakServicePort },
        ...(this.keycloakProtocol === 'https' && {
          policies: {
            tls: this.keycloakExternalUrl
              ? { sni: jwksHost }
              : { sni: jwksHost, insecureSkipVerify: 'Hostname' },
          },
        }),
      },
    };
    await this.applyResource(backend);
  }

  async deployMcpAuthPolicy() {
    const baseUrl = await this.resolveGatewayBaseUrl();
    const issuer = `${this.keycloakBaseUrl}/realms/${this.realm}`;

    const policy = {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: {
        name: this.prefix,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        targetRefs: [
          {
            group: 'gateway.networking.k8s.io',
            kind: 'HTTPRoute',
            name: this.routeName,
          },
        ],
        traffic: {
          jwtAuthentication: {
            mode: 'Strict',
            providers: [
              {
                issuer,
                audiences: this.audiences,
                jwks: {
                  remote: {
                    backendRef: {
                      group: BACKEND_API_GROUP[this.edition],
                      kind: BACKEND_KIND[this.edition],
                      name: `${this.prefix}-jwks`,
                    },
                    cacheDuration: '5m',
                    jwksPath: `realms/${this.realm}/protocol/openid-connect/certs`,
                  },
                },
              },
            ],
            mcp: {
              provider: 'Keycloak',
              // No clientId - unlike Okta/Auth0, Keycloak's real DCR endpoint is open
              // (see configureKeycloakDynamicRegistration), so the controller proxies
              // real registration instead of short-circuiting with a mock response.
              resourceMetadata: {
                'agentgateway.dev/issuer-proxy': `http://enterprise-agentgateway.${this.namespace}.svc.cluster.local:7777/oauth-issuer`,
                authorizationServers: [`${baseUrl}/oauth-issuer`],
                resource: `${baseUrl}${this.mcpPath}`,
                scopesSupported: ['openid'],
              },
            },
          },
        },
      },
    };
    await this.applyResource(policy);
    this.log(`MCP auth policy '${this.prefix}' applied`, 'info');
  }

  // The controller's /oauth-issuer/authorize only proceeds for a resource its own
  // in-memory index recognizes as "known" - confirmed (via solo-io/agentgateway-enterprise
  // source, resource_index.go) to come from EITHER a Policy/Backend's deprecated
  // spec.backend.mcp.authentication.resourceMetadata, or a tokenExchange.elicitation
  // Secret's mcp_resource field wired through a Policy - never from this feature's own
  // spec.traffic.jwtAuthentication.mcp policy above. That indexer reads the policy's spec
  // directly regardless of whether the attached backend ever carries MCP traffic, so this
  // targets this feature's own JWKS backend - a real object (so the policy attaches
  // cleanly, unlike a nonexistent name which would sit permanently Attached: False/Pending)
  // that's only ever referenced via jwks.backendRef for cert fetching, never routed real
  // MCP traffic, so attaching mcp.authentication to it has nothing to enforce against
  // (real JWT enforcement still comes from deployMcpAuthPolicy() above). Mirrors
  // solo-io/solo-field-installer's actual working eager-oauth-auth0-multiplexed-with-unauth
  // demo (auth/mcp-auth0-eager-policy.yaml), which registers its resource the same way.
  async deployResourceIndexPolicy() {
    const baseUrl = await this.resolveGatewayBaseUrl();
    const issuer = `${this.keycloakBaseUrl}/realms/${this.realm}`;
    const name = `${this.prefix}-resource-index`;

    const policy = {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: { name, namespace: this.namespace, labels: this.labels },
      spec: {
        targetRefs: [
          {
            group: BACKEND_API_GROUP[this.edition],
            kind: BACKEND_KIND[this.edition],
            name: `${this.prefix}-jwks`,
          },
        ],
        backend: {
          mcp: {
            authentication: {
              mode: 'Strict',
              issuer,
              audiences: this.audiences,
              jwks: {
                backendRef: {
                  group: BACKEND_API_GROUP[this.edition],
                  kind: BACKEND_KIND[this.edition],
                  name: `${this.prefix}-jwks`,
                },
                jwksPath: `realms/${this.realm}/protocol/openid-connect/certs`,
              },
              resourceMetadata: {
                'agentgateway.dev/issuer-proxy': `http://enterprise-agentgateway.${this.namespace}.svc.cluster.local:7777/oauth-issuer`,
                resource: `${baseUrl}${this.mcpPath}`,
              },
            },
          },
        },
      },
    };
    await this.applyResource(policy);
    this.log(
      `Resource-index policy '${name}' applied (registers '${this.mcpPath}' as a known issuer resource - targets no real backend)`,
      'info'
    );
  }

  async cleanup() {
    this.log(
      'Cleaning up auth-only-mcp feature (KGW_OAUTH_ISSUER_CONFIG left in place)...',
      'info'
    );
    await this.deleteByLabel('EnterpriseAgentgatewayPolicy', {
      'agentgateway.dev/feature': this.name,
    });
    await this.deleteResource(BACKEND_KIND[this.edition], `${this.prefix}-jwks`, this.namespace);
    await this.deleteResource('Deployment', `${this.prefix}-postgres`, this.namespace);
    await this.deleteResource('Service', `${this.prefix}-postgres`, this.namespace);
    await this.deleteResource('Secret', `${this.prefix}-postgres`, this.namespace);
    await this.deleteResource('PersistentVolumeClaim', `${this.prefix}-postgres`, this.namespace);

    const oauthIssuerRoute = new OauthIssuerRouteFeature(this.name, {
      namespace: this.namespace,
      gatewayName: this.gatewayName,
    });
    oauthIssuerRoute.setSpinner(this.spinner);
    oauthIssuerRoute.adoptParentContext(this);
    await oauthIssuerRoute.cleanup();
    if (this.preIssuanceEnabled) {
      await this.deleteResource(
        'Deployment',
        this.preIssuanceExtAuthzName,
        this.preIssuanceExtAuthzNamespace
      );
      await this.deleteResource(
        'Service',
        this.preIssuanceExtAuthzName,
        this.preIssuanceExtAuthzNamespace
      );
      // The resource-index policy is already covered by the deleteByLabel call above -
      // PolicyRegistry renames it to <feature>-<targetRef name> on merge, so its literal
      // name (this.prefix + '-resource-index') doesn't exist on the cluster to delete by.
    }
    this.log('auth-only-mcp feature cleaned up', 'success');
  }
}

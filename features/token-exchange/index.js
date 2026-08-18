import { Feature } from '../../src/lib/feature.js';
import { KubernetesHelper, Logger } from '../../src/lib/common.js';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';

const AGENTGATEWAY_NAMESPACE = process.env.AGENTGATEWAY_NAMESPACE || 'agentgateway-system';
const AGENTGATEWAY_RELEASE = process.env.AGENTGATEWAY_RELEASE || 'enterprise-agentgateway';
const AGENTGATEWAY_VERSION = process.env.AGENTGATEWAY_VERSION || '2.1.1';
const AGENTGATEWAY_OCI_REGISTRY =
  'oci://us-docker.pkg.dev/solo-public/enterprise-agentgateway/charts';
const ENTERPRISE_AGENTGATEWAY_LICENSE = process.env.ENTERPRISE_AGENTGATEWAY_LICENSE;

/**
 * Token Exchange Feature
 *
 * Performs a Helm upgrade on the enterprise-agentgateway release. This one Helm toggle
 * bundles three distinct, independently-configured controller capabilities:
 *
 * 1. STS-based OBO token exchange (tokenExchange.* values) - LEGACY (still supported,
 *    not recommended for new work) for Impersonation and External IdP exchange
 *    specifically: prefer the proxy-native oauth-token-exchange feature
 *    (backend.auth.oauthTokenExchange) instead. It needs no controller/Postgres/STS at
 *    all, and sidesteps a real footgun here: this feature's Helm upgrades always use
 *    --reuse-values, and only ever *set* database/elicitation, never clear them - so a
 *    usecase whose config omits `database` silently inherits whatever Postgres URL a
 *    different, possibly since-cleaned-up usecase last configured, which crash-loops
 *    the controller on DNS resolution failure (live-verified). Every usecase using this
 *    feature directly should deploy its own Postgres via the `postgres` feature and pass
 *    `database.postgres.url` explicitly (see elicitation-oauth-flow, fd-loan-rbac-jwt-propagation)
 *    rather than relying on whatever a previous usecase happened to leave configured.
 *    Keep using the STS for
 *    what oauth-token-exchange genuinely can't do: Delegation (`act` claim, agent-driven
 *    actor-token exchange - see fd-loan-rbac-jwt-propagation,
 *    workload-identity-chain, agent-workload-identity)
 *    and elicitation (interactive third-party OAuth consent stored in the STS - see
 *    elicitation-oauth-flow), neither of which has a proxy-native equivalent yet.
 * 2. Elicitation (tokenExchange.elicitation) - see above, STS-only, not legacy for its
 *    own purpose.
 * 3. The controller's own OAuth issuer proxy (controller.extraEnv.KGW_OAUTH_ISSUER_CONFIG,
 *    set via `oauthIssuerConfig` below) - unrelated to token exchange or the STS
 *    database; this is what fronts an MCP server with the controller's own OAuth
 *    authorization server ("auth-only MCP"/eager-auth - see mcp-eager-auth-okta,
 *    mcp-eager-auth-auth0, auth-only-mcp). Current, not legacy, no alternative exists.
 *
 * References:
 *   OBO: https://docs.solo.io/agentgateway/latest/mcp/token-exchange/obo/delegation/#setup-sts
 *   Elicitation: https://docs.solo.io/agentgateway/latest/mcp/token-exchange/elicitations/
 *   oauth-token-exchange (preferred for Impersonation/External IdP): https://docs.solo.io/agentgateway/latest/security/backend-authn-oauth/
 *   Auth-only MCP: https://docs.solo.io/agentgateway/latest/mcp/token-exchange/auth-only/
 *
 * Configuration:
 * {
 *   issuer: string,           // STS issuer (default: enterprise-agentgateway.<ns>.svc.cluster.local:7777)
 *   tokenExpiration: string,  // Token TTL (default: '24h')
 *   subjectValidator: {
 *     validatorType: string,  // Default: 'remote'
 *     remoteConfig: {
 *       url: string,          // Keycloak JWKS URL
 *     },
 *   },
 *   actorValidator: {
 *     validatorType: string,  // Default: 'k8s'
 *   },
 *   apiValidator: {
 *     validatorType: string,  // Default: 'remote' — validates Solo UI calls to elicitation CRUD
 *     remoteConfig: {
 *       url: string,          // Keycloak JWKS URL (defaults to same as subjectValidator)
 *     },
 *   },
 *   elicitation: {
 *     enabled: boolean,       // Enable elicitation support (default: false)
 *     oidc: {
 *       secretName: string,   // Secret containing OAuth provider credentials
 *     },
 *   },
 *   database: {
 *     postgres: {
 *       url: string,          // postgres://user:pass@host:5432/db?sslmode=disable
 *                              // The controller migrates its own schema - no init SQL needed.
 *     },
 *   },
 *   oauthIssuerConfig: object, // JSON-stringified into controller.extraEnv.KGW_OAUTH_ISSUER_CONFIG
 *                              // (downstream_server/gateway_config/par_config - see
 *                              // https://docs.solo.io/agentgateway/latest/mcp/token-exchange/auth-only/setup/)
 *   callbackUrl: string,       // controller.extraEnv.CALLBACK_URL - the URL the proxy returns to
 *                              // the client when an elicitation is required (e.g. the Solo UI's
 *                              // elicitations path). Must match the OAuth app's redirect_uri.
 *                              // Defaults to the controller's own placeholder if unset.
 * }
 */
export class TokenExchangeFeature extends Feature {
  // Depends on the control-plane STS/token-exchange listener, which has no OSS equivalent.
  // OSS's backendAuth.oauthTokenExchange solves gateway-to-backend auth, a different problem.
  static SUPPORTED_EDITIONS = ['enterprise'];

  constructor(name, config) {
    super(name, config);

    const ns = this.namespace || AGENTGATEWAY_NAMESPACE;

    const kc = config.keycloak || {};
    const realm = kc.realm || 'agw-dev';
    const kcScheme = kc.scheme || 'http';
    const kcPort = kc.port || (kcScheme === 'https' ? 8443 : 8080);
    const kcHost = `${kc.serviceName || 'keycloak'}.${kc.serviceNamespace || 'keycloak'}.svc.cluster.local:${kcPort}`;
    const defaultJwksUrl = `${kcScheme}://${kcHost}/realms/${realm}/protocol/openid-connect/certs`;

    const subjectValidator = config.subjectValidator || {
      validatorType: 'remote',
      remoteConfig: {
        url: config.jwksUrl || defaultJwksUrl,
      },
    };
    if (config.skipMayActClaimValidation) {
      subjectValidator.skipMayActClaimValidation = true;
    }

    const apiValidator = config.apiValidator || {
      validatorType: 'remote',
      remoteConfig: {
        url: config.jwksUrl || defaultJwksUrl,
      },
    };

    this.tokenExchangeValues = {
      tokenExchange: {
        enabled: true,
        issuer: config.issuer || `${AGENTGATEWAY_RELEASE}.${ns}.svc.cluster.local:7777`,
        tokenExpiration: config.tokenExpiration || '24h',
        subjectValidator,
        actorValidator: config.actorValidator || {
          validatorType: 'k8s',
        },
        apiValidator,
      },
    };

    if (config.elicitation?.enabled) {
      this.tokenExchangeValues.tokenExchange.elicitation = {
        enabled: true,
      };
      if (config.elicitation.oidc?.secretName) {
        this.tokenExchangeValues.tokenExchange.elicitation.oidc = {
          secretName: config.elicitation.oidc.secretName,
        };
      }
    }

    if (config.database?.postgres?.url) {
      this.tokenExchangeValues.tokenExchange.database = {
        type: 'postgres',
        postgres: { url: config.database.postgres.url },
      };
    }

    if (config.oauthIssuerConfig || config.callbackUrl) {
      this.tokenExchangeValues.controller = {
        extraEnv: {
          ...(config.oauthIssuerConfig && {
            KGW_OAUTH_ISSUER_CONFIG: JSON.stringify(config.oauthIssuerConfig),
          }),
          ...(config.callbackUrl && { CALLBACK_URL: config.callbackUrl }),
        },
      };
    }
  }

  getFeaturePath() {
    return 'token-exchange';
  }

  validate() {
    return true;
  }

  async getInstalledVersion() {
    try {
      const result = await KubernetesHelper.helm([
        'list',
        '-n',
        AGENTGATEWAY_NAMESPACE,
        '--filter',
        AGENTGATEWAY_RELEASE,
        '-o',
        'json',
      ]);
      const releases = JSON.parse(result.stdout || '[]');
      if (releases.length > 0) {
        // chart field format: "enterprise-agentgateway-v2026.6.2"
        const chartField = releases[0].chart || '';
        const match = chartField.match(/enterprise-agentgateway-(.+)$/);
        if (match) return match[1];
      }
    } catch {
      // fall back to default
    }
    return AGENTGATEWAY_VERSION;
  }

  async deploy() {
    if (this.dryRun) {
      const comment = [
        '# Helm upgrade: enable STS token exchange',
        '# helm upgrade enterprise-agentgateway ... --reuse-values \\',
        '#   -f <values below>',
        yaml.dump(this.tokenExchangeValues, { lineWidth: -1, indent: 2 }).trim(),
      ].join('\n');
      this._dryRunYaml.push(comment);
      return;
    }

    this.log('Enabling STS token exchange via Helm upgrade...', 'info');

    const chartVersion = await this.getInstalledVersion();
    let tempFile = null;

    try {
      tempFile = join(tmpdir(), `agw-token-exchange-${Date.now()}.yaml`);
      await writeFile(
        tempFile,
        yaml.dump(this.tokenExchangeValues, { lineWidth: -1, indent: 2 }),
        'utf8'
      );

      const helmArgs = [
        'upgrade',
        AGENTGATEWAY_RELEASE,
        `${AGENTGATEWAY_OCI_REGISTRY}/enterprise-agentgateway`,
        '--namespace',
        AGENTGATEWAY_NAMESPACE,
        '--version',
        chartVersion,
        '--reuse-values',
        '-f',
        tempFile,
        '--wait',
        '--timeout',
        '5m',
      ];

      if (ENTERPRISE_AGENTGATEWAY_LICENSE) {
        helmArgs.push('--set', `licensing.licenseKey=${ENTERPRISE_AGENTGATEWAY_LICENSE}`);
      }

      await KubernetesHelper.helm(helmArgs);

      // The controller migrates its own DB schema once, at boot. `--reuse-values` means
      // Helm only restarts the controller pod when the resulting values actually differ
      // from what's already deployed - if this same oauthIssuerConfig/Postgres URL was
      // already applied by a previous deploy (e.g. after `usecase clean` tore down and
      // recreated a feature-owned Postgres with a fresh, empty schema), Helm sees no diff
      // and skips the restart, leaving the controller connected to a schema-less DB
      // (surfaces as "relation \"oauth_flow_states\" does not exist" on every OAuth flow -
      // live-verified). Force a restart whenever a Postgres URL is wired in, so the
      // migration always runs against whatever Postgres is actually live right now.
      if (this.tokenExchangeValues.tokenExchange.database?.postgres?.url) {
        this.log('Restarting controller to re-run its DB schema migration...', 'info');
        await KubernetesHelper.kubectl([
          'rollout',
          'restart',
          `deployment/${AGENTGATEWAY_RELEASE}`,
          '-n',
          AGENTGATEWAY_NAMESPACE,
        ]);
        await KubernetesHelper.kubectl([
          'rollout',
          'status',
          `deployment/${AGENTGATEWAY_RELEASE}`,
          '-n',
          AGENTGATEWAY_NAMESPACE,
          '--timeout=120s',
        ]);
      }

      this.log('STS token exchange enabled (port 7777)', 'success');
    } finally {
      if (tempFile) {
        try {
          await unlink(tempFile);
        } catch {
          /* ignore */
        }
      }
    }
  }

  async cleanup() {
    this.log('Disabling STS token exchange via Helm upgrade...', 'info');

    const chartVersion = await this.getInstalledVersion();
    let tempFile = null;

    try {
      const disableValues = { tokenExchange: { enabled: false } };
      tempFile = join(tmpdir(), `agw-token-exchange-disable-${Date.now()}.yaml`);
      await writeFile(tempFile, yaml.dump(disableValues, { lineWidth: -1, indent: 2 }), 'utf8');

      const helmArgs = [
        'upgrade',
        AGENTGATEWAY_RELEASE,
        `${AGENTGATEWAY_OCI_REGISTRY}/enterprise-agentgateway`,
        '--namespace',
        AGENTGATEWAY_NAMESPACE,
        '--version',
        chartVersion,
        '--reuse-values',
        '-f',
        tempFile,
        '--wait',
        '--timeout',
        '5m',
      ];

      if (ENTERPRISE_AGENTGATEWAY_LICENSE) {
        helmArgs.push('--set', `licensing.licenseKey=${ENTERPRISE_AGENTGATEWAY_LICENSE}`);
      }

      await KubernetesHelper.helm(helmArgs);

      this.log('STS token exchange disabled', 'success');
    } catch (error) {
      this.log(`Failed to disable token exchange: ${error.message}`, 'warn');
    } finally {
      if (tempFile) {
        try {
          await unlink(tempFile);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

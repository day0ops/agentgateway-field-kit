import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { BACKEND_API_GROUP, BACKEND_KIND } from '../../src/lib/editions.js';

const PROVIDER_DEFAULTS = {
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    accessTokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['read:user', 'repo'],
    upstreamPath: '/mcp/',
  },
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    accessTokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'profile'],
  },
};

/**
 * Elicitation Backend Feature
 *
 * Creates an AgentgatewayBackend and EnterpriseAgentgatewayPolicy configured
 * for token exchange with elicitation support. This enables the out-of-band
 * OAuth consent flow where agents can request user authorization for external
 * APIs (e.g., GitHub, Google) on behalf of users.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/mcp/token-exchange/elicitations/setup/
 *
 * Flow:
 * 1. Agent makes request to backend requiring external API access
 * 2. STS checks for upstream token; if missing, returns elicitation URL (PENDING)
 * 3. User opens URL in Solo UI, completes OAuth with external provider
 * 4. STS stores token (COMPLETED)
 * 5. Agent retries; token is injected into upstream request's Authorization header
 *
 * This feature:
 * - Creates an AgentgatewayBackend for the external API
 * - Creates an EnterpriseAgentgatewayPolicy with either
 *   `backend.entElicitation.interactive` (mode: 'interactive', default - the Solo
 *   Enterprise UI drives the OAuth consent flow, referencing the client secret
 *   created by elicitation-secret) or `backend.entElicitation.brokered`
 *   (mode: 'brokered' - the gateway's own OAuth issuer coordinates discovery,
 *   dynamic client registration and PKCE with the upstream provider; fits
 *   DCR+PKCE-only providers like Stripe). Both modes also set
 *   `backend.entTokenExchange.solo.elicitation` (required to actually engage the
 *   STS lookup/injection path - see deployPolicy()).
 * - Creates an HTTPRoute for the backend
 *
 * Configuration:
 * {
 *   backendName: string,             // AgentgatewayBackend name (default: 'elicitation-backend')
 *   policyName: string,              // EnterpriseAgentgatewayPolicy name (default: 'elicitation-policy')
 *   routeName: string,               // HTTPRoute name (default: 'elicitation-route')
 *   pathPrefix: string,              // Route path prefix (default: '/api')
 *   mode: string,                    // 'interactive' (default) or 'brokered'
 *
 *   // mode: 'interactive' (UI-driven consent flow)
 *   secretName: string,              // Secret holding client_secret, created by elicitation-secret (required)
 *   provider: string,                // Provider defaults for authorizeUrl/accessTokenUrl/scopes (default: 'github')
 *   clientId: string,                // OAuth client ID (required, or use env var)
 *   clientIdEnvVar: string,          // Env var for client ID (default: '<PROVIDER>_CLIENT_ID')
 *   authorizeUrl: string,            // OAuth authorize URL (required for custom providers)
 *   accessTokenUrl: string,          // OAuth access token URL (required for custom providers)
 *   scopes: Array<string>,           // OAuth scopes requested during the flow
 *   redirectUri: string,             // OAuth redirect URI, registered with the provider
 *                                     // (default: 'http://localhost:4000/age/elicitations')
 *
 *   // mode: 'brokered' (gateway-owned OAuth issuer; discovery + DCR + PKCE)
 *   brokered: {
 *     mcpResourcePath: string,       // RFC 9728 protected-resource path (required, must start with '/')
 *     chainedAuth: {                 // the upstream leg; omit for downstream-only
 *       baseUrl: string,             // discovery + dynamic client registration + PKCE base URL
 *       authorizeUrl: string,        // alternative to baseUrl: explicit authorize URL
 *       accessTokenUrl: string,      // alternative to baseUrl: explicit token URL
 *       clientId: string,            // optional - omit to use dynamic client registration
 *       clientSecretRef: object,     // optional - { name: string }
 *       scopes: Array<string>,       // optional
 *       registrationUrl: string,     // optional - DCR endpoint override
 *       clientName: string,          // optional - name presented during DCR
 *       pkce: object,                // optional - PKCE overrides
 *       consent: object,             // optional - { disabled?, platformName?, logoUrl?, legalText? }
 *     },
 *   },
 *
 *   upstream: {
 *     host: string,                  // Upstream API host (e.g., 'api.github.com')
 *     port: number,                  // Upstream port (default: 443)
 *     path: string,                  // Upstream MCP path (default: provider default, e.g. '/mcp/' for github)
 *     tls: boolean,                  // Enable TLS (default: true)
 *     insecureSkipVerify: boolean,   // Skip TLS verification (default: false)
 *   },
 * }
 *
 * Supported providers with defaults (mode: 'interactive'):
 * - github: GitHub OAuth
 * - google: Google OAuth
 * - custom: Requires authorizeUrl and accessTokenUrl
 */
export class ElicitationBackendFeature extends Feature {
  // Depends on the control-plane STS/token-exchange listener (backend.entElicitation),
  // which has no OSS equivalent - OSS has no Elicitation type at all in its policy CRD.
  static SUPPORTED_EDITIONS = ['enterprise'];

  constructor(name, config) {
    super(name, config);

    this.backendName = config.backendName || 'elicitation-backend';
    this.policyName = config.policyName || 'elicitation-policy';
    this.routeName = config.routeName || 'elicitation-route';
    this.pathPrefix = config.pathPrefix || '/api';
    this.secretName = config.secretName || 'elicitation-oauth';
    this.provider = (config.provider || 'github').toLowerCase();
    this.mode = (config.mode || 'interactive').toLowerCase();

    const clientIdEnvVar = config.clientIdEnvVar || `${this.provider.toUpperCase()}_CLIENT_ID`;
    this.clientId = config.clientId || process.env[clientIdEnvVar] || '';

    const defaults = PROVIDER_DEFAULTS[this.provider] || {};
    this.authorizeUrl = config.authorizeUrl || defaults.authorizeUrl || '';
    this.accessTokenUrl = config.accessTokenUrl || defaults.accessTokenUrl || '';
    this.scopes = config.scopes || defaults.scopes || [];
    this.redirectUri = config.redirectUri || 'http://localhost:4000/age/elicitations';

    this.brokered = config.brokered || {};

    const upstream = config.upstream || {};
    this.upstreamHost = upstream.host || 'api.github.com';
    this.upstreamPort = upstream.port || 443;
    this.upstreamPath = upstream.path || defaults.upstreamPath || '';
    this.upstreamTls = upstream.tls !== false;
    this.upstreamInsecureSkipVerify = upstream.insecureSkipVerify || false;
  }

  getFeaturePath() {
    return 'elicitation-backend';
  }

  validate() {
    if (this.mode === 'brokered') {
      if (!this.upstreamHost) {
        throw new Error('Elicitation backend requires upstream.host');
      }
      if (!this.brokered.mcpResourcePath) {
        throw new Error('Elicitation backend (brokered mode) requires brokered.mcpResourcePath');
      }
      if (!this.brokered.mcpResourcePath.startsWith('/')) {
        throw new Error(
          'Elicitation backend (brokered mode) requires brokered.mcpResourcePath to start with "/"'
        );
      }
      return true;
    }

    if (!this.secretName) {
      throw new Error('Elicitation backend requires secretName');
    }
    if (!this.clientId) {
      throw new Error(
        `Elicitation backend requires clientId or ${this.provider.toUpperCase()}_CLIENT_ID env var`
      );
    }
    if (!this.authorizeUrl) {
      throw new Error('Elicitation backend requires authorizeUrl for custom providers');
    }
    if (!this.accessTokenUrl) {
      throw new Error('Elicitation backend requires accessTokenUrl for custom providers');
    }
    if (!this.upstreamHost) {
      throw new Error('Elicitation backend requires upstream.host');
    }
    return true;
  }

  async deploy() {
    this.log(`Configuring elicitation backend '${this.backendName}'...`, 'info');

    await this.deployBackend();
    await this.deployPolicy();
    await this.deployHTTPRoute();

    this.log('Elicitation backend configured', 'success');
  }

  async deployBackend() {
    // Must be a proper MCP target (spec.mcp.targets[]), not a bare spec.static -
    // static/mcp/entMcp are mutually exclusive backend-type fields, and the
    // token-exchange/elicitation subsystem only attaches to mcp/entMcp targets.
    // A bare static backend silently fails every exchange with "token exchange
    // required but not configured", regardless of how the Policy is written
    // (live-verified against the working repo-mcp-standard-backend, which uses
    // this same mcp.targets[] shape).
    const backend = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: this.backendName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        mcp: {
          targets: [
            {
              name: this.backendName,
              static: {
                host: this.upstreamHost,
                port: this.upstreamPort,
                protocol: 'StreamableHTTP',
                ...(this.upstreamPath && { path: this.upstreamPath }),
                ...(this.upstreamTls && { policies: { tls: { sni: this.upstreamHost } } }),
              },
            },
          ],
        },
      },
    };

    await this.applyResource(backend);
    this.log(`${BACKEND_KIND[this.edition]} '${this.backendName}' created`, 'info');
  }

  /**
   * Builds the `entElicitation.brokered` block for mode: 'brokered'. The gateway owns
   * discovery/DCR/PKCE with the upstream provider (no redirectUri - that's an
   * interactive-only field), so only fields explicitly provided in config.brokered are
   * emitted.
   * @returns {{brokered: {mcpResourcePath: string, chainedAuth?: object}}}
   */
  buildBrokeredElicitation() {
    const { mcpResourcePath, chainedAuth } = this.brokered;
    const brokered = { mcpResourcePath };

    if (chainedAuth) {
      const oauth = {};
      if (chainedAuth.baseUrl) oauth.baseUrl = chainedAuth.baseUrl;
      if (chainedAuth.authorizeUrl) oauth.authorizeUrl = chainedAuth.authorizeUrl;
      if (chainedAuth.accessTokenUrl) oauth.accessTokenUrl = chainedAuth.accessTokenUrl;
      if (chainedAuth.clientId) oauth.clientId = chainedAuth.clientId;
      if (chainedAuth.clientSecretRef) oauth.clientSecretRef = chainedAuth.clientSecretRef;
      if (chainedAuth.scopes) oauth.scopes = chainedAuth.scopes;
      if (chainedAuth.registrationUrl) oauth.registrationUrl = chainedAuth.registrationUrl;
      if (chainedAuth.clientName) oauth.clientName = chainedAuth.clientName;
      if (chainedAuth.pkce) oauth.pkce = chainedAuth.pkce;
      if (chainedAuth.consent) oauth.consent = chainedAuth.consent;

      brokered.chainedAuth = { oauth };
    }

    return { brokered };
  }

  async deployPolicy() {
    const policy = {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: {
        name: this.policyName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        targetRefs: [
          {
            group: BACKEND_API_GROUP[this.edition],
            kind: BACKEND_KIND[this.edition],
            name: this.backendName,
          },
        ],
        backend: {
          entElicitation:
            this.mode === 'brokered'
              ? this.buildBrokeredElicitation()
              : {
                  interactive: {
                    oauth: {
                      clientId: this.clientId,
                      clientSecretRef: { name: this.secretName },
                      scopes: this.scopes,
                      redirectUri: this.redirectUri,
                      authorizeUrl: this.authorizeUrl,
                      accessTokenUrl: this.accessTokenUrl,
                    },
                  },
                },
          // Required alongside entElicitation - without it the proxy never engages the
          // STS lookup/injection path for this backend's traffic at all, so requests
          // pass straight through regardless of whether an upstream token exists.
          // entTokenExchange.solo.elicitation is the shape that actually works -
          // live-verified against docs.solo.io's Interactive/GitHub worked example.
          // The previous tokenExchange.elicitation.secretName field is mutually
          // exclusive with entElicitation - the K8s admission webhook rejects any
          // policy combining both outright ("entElicitation is mutually exclusive
          // with the deprecated tokenExchange.elicitation"), so this feature could
          // never have deployed successfully as written.
          entTokenExchange: {
            solo: {
              elicitation: {},
            },
          },
        },
      },
    };

    if (this.upstreamTls && this.upstreamInsecureSkipVerify) {
      policy.spec.backend.tls = { insecureSkipVerify: 'All' };
    }

    await this.applyResource(policy);
    this.log(`EnterpriseAgentgatewayPolicy '${this.policyName}' created with elicitation`, 'info');
  }

  async deployHTTPRoute() {
    const gatewayRef = FeatureManager.getGatewayRef();

    const route = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        parentRefs: [
          {
            name: gatewayRef.name,
            namespace: gatewayRef.namespace,
          },
        ],
        rules: [
          {
            matches: [
              {
                path: {
                  type: 'PathPrefix',
                  value: this.pathPrefix,
                },
              },
            ],
            filters: [
              {
                type: 'URLRewrite',
                urlRewrite: {
                  path: {
                    type: 'ReplacePrefixMatch',
                    replacePrefixMatch: '/',
                  },
                },
              },
            ],
            backendRefs: [
              {
                name: this.backendName,
                group: BACKEND_API_GROUP[this.edition],
                kind: BACKEND_KIND[this.edition],
              },
            ],
          },
        ],
      },
    };

    await this.applyResource(route);
    this.log(`HTTPRoute '${this.routeName}' created at ${this.pathPrefix}`, 'info');
  }

  async cleanup() {
    this.log('Cleaning up elicitation backend...', 'info');

    await this.deleteResource('HTTPRoute', this.routeName);
    await this.deleteResource('EnterpriseAgentgatewayPolicy', this.policyName);
    await this.deleteResource(BACKEND_KIND[this.edition], this.backendName);

    this.log('Elicitation backend cleaned up', 'success');
  }
}

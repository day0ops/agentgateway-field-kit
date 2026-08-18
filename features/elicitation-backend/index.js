import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { BACKEND_API_GROUP, BACKEND_KIND } from '../../src/lib/editions.js';

const PROVIDER_DEFAULTS = {
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    accessTokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['read:user', 'repo'],
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
 * - Creates an EnterpriseAgentgatewayPolicy with `backend.entElicitation.interactive`
 *   (the Solo Enterprise UI drives the OAuth consent flow), referencing the client
 *   secret created by elicitation-secret. `backend.tokenExchange.elicitation`
 *   (the opaque-Secret shape) is deprecated in favor of this typed field, per
 *   Solo's migration notes - only the client secret still lives in a Secret.
 * - Creates an HTTPRoute for the backend
 *
 * Configuration:
 * {
 *   backendName: string,             // AgentgatewayBackend name (default: 'elicitation-backend')
 *   policyName: string,              // EnterpriseAgentgatewayPolicy name (default: 'elicitation-policy')
 *   routeName: string,               // HTTPRoute name (default: 'elicitation-route')
 *   pathPrefix: string,              // Route path prefix (default: '/api')
 *   secretName: string,              // Secret holding client_secret, created by elicitation-secret (required)
 *   provider: string,                // Provider defaults for authorizeUrl/accessTokenUrl/scopes (default: 'github')
 *   clientId: string,                // OAuth client ID (required, or use env var)
 *   clientIdEnvVar: string,          // Env var for client ID (default: '<PROVIDER>_CLIENT_ID')
 *   authorizeUrl: string,            // OAuth authorize URL (required for custom providers)
 *   accessTokenUrl: string,          // OAuth access token URL (required for custom providers)
 *   scopes: Array<string>,           // OAuth scopes requested during the flow
 *   redirectUri: string,             // OAuth redirect URI, registered with the provider
 *                                     // (default: 'http://localhost:4000/age/elicitations')
 *   upstream: {
 *     host: string,                  // Upstream API host (e.g., 'api.github.com')
 *     port: number,                  // Upstream port (default: 443)
 *     tls: boolean,                  // Enable TLS (default: true)
 *     insecureSkipVerify: boolean,   // Skip TLS verification (default: false)
 *   },
 * }
 *
 * Supported providers with defaults:
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

    const clientIdEnvVar = config.clientIdEnvVar || `${this.provider.toUpperCase()}_CLIENT_ID`;
    this.clientId = config.clientId || process.env[clientIdEnvVar] || '';

    const defaults = PROVIDER_DEFAULTS[this.provider] || {};
    this.authorizeUrl = config.authorizeUrl || defaults.authorizeUrl || '';
    this.accessTokenUrl = config.accessTokenUrl || defaults.accessTokenUrl || '';
    this.scopes = config.scopes || defaults.scopes || [];
    this.redirectUri = config.redirectUri || 'http://localhost:4000/age/elicitations';

    const upstream = config.upstream || {};
    this.upstreamHost = upstream.host || 'api.github.com';
    this.upstreamPort = upstream.port || 443;
    this.upstreamTls = upstream.tls !== false;
    this.upstreamInsecureSkipVerify = upstream.insecureSkipVerify || false;
  }

  getFeaturePath() {
    return 'elicitation-backend';
  }

  validate() {
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
        static: {
          host: this.upstreamHost,
          port: this.upstreamPort,
        },
        ...(this.upstreamTls && { policies: { tls: { sni: this.upstreamHost } } }),
      },
    };

    await this.applyResource(backend);
    this.log(`${BACKEND_KIND[this.edition]} '${this.backendName}' created`, 'info');
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
          entElicitation: {
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
          // pass straight through regardless of whether an upstream token exists
          // (live-verified: confirmed via CRD schema + Solo's own httpbin reference
          // example at docs.solo.io/agentgateway/latest/mcp/token-exchange/elicitations/setup).
          // ElicitationOnly stores the upstream (GitHub) token without replacing the
          // caller's own IdP bearer token.
          tokenExchange: {
            mode: 'ElicitationOnly',
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

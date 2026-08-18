import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { BACKEND_API_GROUP, BACKEND_KIND } from '../../src/lib/editions.js';

const DEFAULT_AUDIENCES = ['api://default'];

/**
 * MCP Eager-Auth (Okta) Feature
 *
 * Same "auth-only MCP" pattern as mcp-eager-auth-auth0/mcp-eager-auth-entra (see those
 * features' doc comments) - agentgateway's built-in MCP-auth bridge for `provider:
 * Okta`, federating with Okta directly (no controller-hosted OAuth issuer, no
 * Postgres). Configured via `traffic.jwtAuthentication` + its `mcp` extension field,
 * targeting the HTTPRoute - `backend.mcp.authentication` (targeting the backend) is
 * deprecated in favor of this route-level shape, per Solo's API reference.
 *
 * Previously fronted by the gateway controller's separate OAuth issuer (port 7777,
 * Postgres-backed) instead - abandoned because the controller's resource index
 * (ent-controller/internal/issuer/resource_index.go) only reads the deprecated
 * `backend.mcp.authentication` field, never the `traffic.jwtAuthentication.mcp` shape
 * this feature (and mcp-auth generally) is supposed to use per Solo's own guidance -
 * so a real controller-brokered authorize request always 400s with "invalid
 * authorization request" (live-verified; worth reporting upstream). Since Okta's lack
 * of Dynamic Client Registration is the same limitation Entra has, and Entra already
 * solves it with a pre-registered `clientId` short-circuit on this same built-in
 * adapter with no controller involved, Okta uses that instead of a controller broker.
 *
 * Real, anonymous Dynamic Client Registration against Okta was tried and abandoned
 * separately - Okta's `/oauth2/v1/clients` API rejects unauthenticated requests, and
 * even a fully correct client_credentials + private_key_jwt + DPoP-bound access token
 * scoped to `okta.clients.manage` still got a 403 access_denied from Okta's own
 * authorization policy (live-verified against two separate Okta orgs). `clientId`
 * below makes the gateway's DCR handler short-circuit with a mock response carrying
 * this client_id instead of proxying real DCR to Okta - MCP clients (e.g. the MCP
 * inspector) then complete DCR with no manual client ID entry needed, and proceed
 * with a real authorization_code + PKCE login against Okta using that pre-registered
 * app directly - no client secret needed.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/mcp/auth/setup/
 *
 * Configuration:
 * {
 *   name: string,               // Resource name prefix (default: 'mcp-eager-auth-okta')
 *   oktaDomain: string,         // Okta domain, e.g. 'dev-123456.okta.com' (required)
 *   authServerId: string,       // Okta auth server ID (default: 'default')
 *   clientId: string,           // Pre-registered app client ID - doubles as the mock-DCR
 *                               // client_id (required; default: OKTA_ISSUER_CLIENT_ID env var)
 *   audiences: string[],        // Expected token audiences (default: ['api://default'])
 *   mcpPath: string,            // MCP connection/discovery path prefix (default: '/mcp')
 *   backendName: string,        // Backend to protect, created by mcp-server (default: 'mcp-backend')
 *   routeName: string,          // HTTPRoute to extend with discovery paths + CORS (default: 'mcp')
 *   resource: string,           // OAuth resource identifier (default: 'http://localhost:8080' + mcpPath)
 *   scopesSupported: string[],  // Default: ['openid']
 *   bearerMethodsSupported: string[], // Default: ['header']
 *   cors: {
 *     enabled: boolean,                   // Enable CORS on the route (default: true)
 *     allowOrigins: Array<string>,        // Default: ['*']
 *     allowMethods: Array<string>,        // Default: ['*']
 *     allowHeaders: Array<string>,        // Default: ['Origin','Authorization','Content-Type']
 *     exposeHeaders: Array<string>,       // Default: ['Origin','X-HTTPRoute-Header']
 *     maxAge: number,                     // Default: 86400
 *   },
 * }
 */
export class McpEagerAuthOktaFeature extends Feature {
  static SUPPORTED_EDITIONS = ['enterprise'];

  get prefix() {
    return this.config.name || 'mcp-eager-auth-okta';
  }

  get oktaDomain() {
    return this.config.oktaDomain;
  }

  get authServerId() {
    return this.config.authServerId || 'default';
  }

  get clientId() {
    return this.config.clientId || process.env.OKTA_ISSUER_CLIENT_ID || '';
  }

  get audiences() {
    return this.config.audiences || DEFAULT_AUDIENCES;
  }

  get mcpPath() {
    return this.config.mcpPath || '/mcp';
  }

  get backendName() {
    return this.config.backendName || 'mcp-backend';
  }

  get routeName() {
    return this.config.routeName || 'mcp';
  }

  get resource() {
    return this.config.resource || `http://localhost:8080${this.mcpPath}`;
  }

  get scopesSupported() {
    return this.config.scopesSupported || ['openid'];
  }

  get bearerMethodsSupported() {
    return this.config.bearerMethodsSupported || ['header'];
  }

  get corsEnabled() {
    return (this.config.cors || {}).enabled !== false;
  }

  get corsAllowOrigins() {
    return (this.config.cors || {}).allowOrigins || ['*'];
  }

  get corsAllowMethods() {
    return (this.config.cors || {}).allowMethods || ['*'];
  }

  get corsAllowHeaders() {
    return (this.config.cors || {}).allowHeaders || ['Origin', 'Authorization', 'Content-Type'];
  }

  get corsExposeHeaders() {
    return (this.config.cors || {}).exposeHeaders || ['Origin', 'X-HTTPRoute-Header'];
  }

  get corsMaxAge() {
    return (this.config.cors || {}).maxAge || 86400;
  }

  get labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
    };
  }

  async deploy() {
    if (!this.oktaDomain) throw new Error('mcp-eager-auth-okta requires oktaDomain in config');
    // clientId is only needed to complete a real Okta login - the 401/discovery behavior
    // this usecase's automated tests check works without it. Require it for a real
    // deploy, but not for dry-run.
    if (!this.dryRun && !this.clientId) {
      throw new Error(
        'mcp-eager-auth-okta requires clientId in config (or OKTA_ISSUER_CLIENT_ID) for a real deploy'
      );
    }

    this.log('Deploying MCP eager-auth (Okta) infrastructure...', 'info');

    await this.deployOktaJwksBackend();
    await this.deployMcpAuthPolicy();
    await this.deployDiscoveryRoute();

    this.log('MCP eager-auth (Okta) deployed', 'success');
  }

  async deployOktaJwksBackend() {
    const backend = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: `${this.prefix}-jwks`,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        static: { host: this.oktaDomain, port: 443 },
        policies: { tls: { sni: this.oktaDomain } },
      },
    };
    await this.applyResource(backend);
  }

  async deployMcpAuthPolicy() {
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
                issuer: `https://${this.oktaDomain}/oauth2/${this.authServerId}`,
                audiences: this.audiences,
                jwks: {
                  remote: {
                    backendRef: {
                      group: BACKEND_API_GROUP[this.edition],
                      kind: BACKEND_KIND[this.edition],
                      name: `${this.prefix}-jwks`,
                    },
                    cacheDuration: '5m',
                    // No leading slash - Okta's JWKS path is relative in this field, unlike Entra's.
                    jwksPath: `oauth2/${this.authServerId}/v1/keys`,
                  },
                },
              },
            ],
            mcp: {
              provider: 'Okta',
              // Without this, the proxy's DCR handler proxies real Dynamic Client
              // Registration to Okta's /oauth2/v1/clients API, which needs an Okta API
              // token we don't have. Setting clientId makes the proxy short-circuit
              // with a mock DCR response carrying this client_id instead - MCP clients
              // (e.g. the MCP inspector) then complete DCR with no manual client ID
              // entry needed.
              clientId: this.clientId,
              resourceMetadata: {
                resource: this.resource,
                scopesSupported: this.scopesSupported,
                bearerMethodsSupported: this.bearerMethodsSupported,
              },
            },
          },
        },
      },
    };
    await this.applyResource(policy);
    this.log(`MCP auth policy '${this.prefix}' applied`, 'info');
  }

  async deployDiscoveryRoute() {
    const gatewayRef = FeatureManager.getGatewayRef();

    const rule = {
      backendRefs: [
        {
          name: this.backendName,
          group: BACKEND_API_GROUP[this.edition],
          kind: BACKEND_KIND[this.edition],
        },
      ],
      matches: [
        { path: { type: 'PathPrefix', value: this.mcpPath } },
        {
          path: {
            type: 'PathPrefix',
            value: `/.well-known/oauth-protected-resource${this.mcpPath}`,
          },
        },
        {
          path: {
            type: 'PathPrefix',
            value: `/.well-known/oauth-authorization-server${this.mcpPath}`,
          },
        },
      ],
    };

    if (this.corsEnabled) {
      rule.filters = [
        {
          type: 'CORS',
          cors: {
            allowCredentials: true,
            allowHeaders: this.corsAllowHeaders,
            allowMethods: this.corsAllowMethods,
            allowOrigins: this.corsAllowOrigins,
            exposeHeaders: this.corsExposeHeaders,
            maxAge: this.corsMaxAge,
          },
        },
      ];
    }

    const route = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        parentRefs: [
          {
            name: gatewayRef.name,
            namespace: gatewayRef.namespace,
          },
        ],
        rules: [rule],
      },
    };

    await this.applyResource(route);
    this.log(`HTTPRoute '${this.routeName}' updated with MCP auth discovery paths`, 'info');
  }

  async cleanup() {
    this.log('Cleaning up mcp-eager-auth-okta feature...', 'info');
    // Policy coalescing (PolicyRegistry) renames the applied EnterpriseAgentgatewayPolicy to
    // <feature>-<targetRef name> (or merged-<features>-<targetRef name>), so the literal
    // this.prefix name doesn't exist on the cluster - delete by the feature label instead.
    await this.deleteByLabel('EnterpriseAgentgatewayPolicy', {
      'agentgateway.dev/feature': this.name,
    });
    await this.deleteResource(BACKEND_KIND[this.edition], `${this.prefix}-jwks`, this.namespace);
    this.log('mcp-eager-auth-okta feature cleaned up', 'success');
  }
}

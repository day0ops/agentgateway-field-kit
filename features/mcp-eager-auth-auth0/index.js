import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { BACKEND_API_GROUP, BACKEND_KIND } from '../../src/lib/editions.js';

/**
 * MCP Eager-Auth (Auth0) Feature
 *
 * Same "auth-only MCP" pattern as mcp-eager-auth-okta (see that feature's doc
 * comment) - agentgateway's built-in MCP-auth bridge for `provider: Auth0`,
 * federating with Auth0 directly (no controller-hosted OAuth issuer, no
 * pre-configured clientId). Configured via `traffic.jwtAuthentication` + its
 * `mcp` extension field, targeting the HTTPRoute - `backend.mcp.authentication`
 * (targeting the backend) is deprecated in favor of this route-level shape,
 * per Solo's API reference. Kept as a separate feature rather than a shared
 * one, per Auth0's differences from Okta:
 * - issuer has a trailing slash (`https://<domain>/`) - Okta's does not
 * - JWKS path is the standard `.well-known/jwks.json`
 * - the Auth0 adapter injects the `audience` param on the client's behalf
 *   (from `audiences` below) so Auth0 returns a JWT instead of an opaque
 *   access token - the same "audience injection" behavior Solo's docs
 *   describe for this adapter
 *
 * Reference: https://docs.solo.io/agentgateway/latest/mcp/auth/setup/
 *
 * Configuration:
 * {
 *   name: string,               // Resource name prefix (default: 'mcp-eager-auth-auth0')
 *   auth0Domain: string,        // Auth0 tenant domain, e.g. 'dev-123456.us.auth0.com' (required)
 *   audience: string,           // Auth0 API identifier (required)
 *   audiences: string[],        // Expected token audiences (default: [audience])
 *   mcpPath: string,            // MCP connection/discovery path prefix (default: '/mcp')
 *   backendName: string,        // Backend to protect, created by mcp-server (default: 'mcp-backend')
 *   routeName: string,          // HTTPRoute to extend with discovery paths + CORS (default: 'mcp')
 *   resource: string,           // OAuth resource identifier (default: 'http://localhost:8080' + mcpPath)
 *   scopesSupported: string[],  // OAuth scopes advertised in resource metadata (default: ['openid'])
 *   bearerMethodsSupported: string[], // Default: ['header', 'body', 'query']
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
export class McpEagerAuthAuth0Feature extends Feature {
  static SUPPORTED_EDITIONS = ['enterprise'];

  get prefix() {
    return this.config.name || 'mcp-eager-auth-auth0';
  }

  get auth0Domain() {
    return this.config.auth0Domain;
  }

  get audience() {
    return this.config.audience;
  }

  get audiences() {
    return this.config.audiences || (this.audience ? [this.audience] : []);
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
    return this.config.bearerMethodsSupported || ['header', 'body', 'query'];
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
    if (!this.auth0Domain) throw new Error('mcp-eager-auth-auth0 requires auth0Domain in config');
    if (!this.audience) throw new Error('mcp-eager-auth-auth0 requires audience in config');

    this.log('Deploying MCP eager-auth (Auth0) infrastructure...', 'info');

    await this.deployAuth0JwksBackend();
    await this.deployMcpAuthPolicy();
    await this.deployDiscoveryRoute();

    this.log('MCP eager-auth (Auth0) deployed', 'success');
  }

  async deployAuth0JwksBackend() {
    const backend = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: `${this.prefix}-jwks`,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        static: { host: this.auth0Domain, port: 443 },
        policies: { tls: { sni: this.auth0Domain } },
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
                // Trailing slash - Auth0's `iss` claim always includes it (opposite of Okta).
                issuer: `https://${this.auth0Domain}/`,
                audiences: this.audiences,
                jwks: {
                  remote: {
                    backendRef: {
                      group: BACKEND_API_GROUP[this.edition],
                      kind: BACKEND_KIND[this.edition],
                      name: `${this.prefix}-jwks`,
                    },
                    cacheDuration: '5m',
                    jwksPath: '.well-known/jwks.json',
                  },
                },
              },
            ],
            mcp: {
              provider: 'Auth0',
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
    this.log(`EnterpriseAgentgatewayPolicy '${this.prefix}' applied`, 'info');
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
    this.log('Cleaning up mcp-eager-auth-auth0 feature...', 'info');
    // Policy coalescing (PolicyRegistry) renames the applied EnterpriseAgentgatewayPolicy to
    // <feature>-<targetRef name> (or merged-<features>-<targetRef name>), so the literal
    // this.prefix name doesn't exist on the cluster - delete by the feature label instead.
    await this.deleteByLabel('EnterpriseAgentgatewayPolicy', {
      'agentgateway.dev/feature': this.name,
    });
    await this.deleteResource(BACKEND_KIND[this.edition], `${this.prefix}-jwks`, this.namespace);
    this.log('mcp-eager-auth-auth0 feature cleaned up', 'success');
  }
}

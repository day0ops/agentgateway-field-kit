import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { BACKEND_API_GROUP, BACKEND_KIND } from '../../src/lib/editions.js';

const ENTRA_HOST = 'login.microsoftonline.com';

/**
 * MCP Eager-Auth (Entra) Feature
 *
 * Same "auth-only MCP" pattern as mcp-eager-auth-auth0/mcp-eager-auth-okta (see
 * those features' doc comments) - agentgateway's built-in MCP-auth bridge for
 * `provider: Entra`, federating with Microsoft Entra ID directly (no controller-hosted
 * OAuth issuer, no Postgres). Configured via `traffic.jwtAuthentication` + its `mcp`
 * extension field, targeting the HTTPRoute - `backend.mcp.authentication` (targeting the
 * backend) is deprecated in favor of this route-level shape, per Solo's API reference.
 * Kept as a separate feature rather than a shared one, per Entra's differences from its
 * siblings:
 * - Entra has no Dynamic Client Registration, so (like Okta, unlike Auth0) this needs
 *   a pre-registered `clientId` for the adapter's mock-DCR short-circuit
 * - the flow requires a public/PKCE client app registration (no secret) - Solo's docs
 *   note confidential-client secret injection via this CRD path isn't yet supported
 * - the adapter rejects/strips the RFC 8707 `resource` param real MCP clients send
 *
 * Reference: https://docs.solo.io/agentgateway/latest/mcp/auth/entra/
 *
 * Configuration:
 * {
 *   name: string,               // Resource name prefix (default: 'mcp-eager-auth-entra')
 *   tenantId: string,           // Entra tenant ID (required)
 *   clientId: string,           // Pre-registered app registration client ID - doubles as
 *                               // the JWT audience source and the mock-DCR client_id (required)
 *   scopeName: string,          // Exposed custom-API scope name (default: 'mcp_access')
 *   issuer: string,             // Default: v2 issuer `https://login.microsoftonline.com/<tenantId>/v2.0`
 *                               // (override to the v1 form `https://sts.windows.net/<tenantId>/` if needed)
 *   mcpPath: string,            // MCP connection/discovery path prefix (default: '/mcp')
 *   backendName: string,        // Backend to protect, created by mcp-server (default: 'mcp-backend')
 *   routeName: string,          // HTTPRoute to extend with discovery paths + CORS (default: 'mcp')
 *   resource: string,           // OAuth resource identifier (default: 'http://localhost:8080' + mcpPath)
 *   bearerMethodsSupported: string[], // Default: ['header'] per Solo's docs
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
export class McpEagerAuthEntraFeature extends Feature {
  static SUPPORTED_EDITIONS = ['enterprise'];

  get prefix() {
    return this.config.name || 'mcp-eager-auth-entra';
  }

  get tenantId() {
    return this.config.tenantId;
  }

  get clientId() {
    return this.config.clientId;
  }

  get scopeName() {
    return this.config.scopeName || 'mcp_access';
  }

  get issuer() {
    return this.config.issuer || `https://login.microsoftonline.com/${this.tenantId}/v2.0`;
  }

  get audiences() {
    return [`api://${this.clientId}`, this.clientId];
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
    return [`api://${this.clientId}/${this.scopeName}`];
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
    if (!this.tenantId) throw new Error('mcp-eager-auth-entra requires tenantId in config');
    if (!this.clientId) throw new Error('mcp-eager-auth-entra requires clientId in config');

    this.log('Deploying MCP eager-auth (Entra) infrastructure...', 'info');

    await this.deployEntraJwksBackend();
    await this.deployMcpAuthPolicy();
    await this.deployDiscoveryRoute();

    this.log('MCP eager-auth (Entra) deployed', 'success');
  }

  async deployEntraJwksBackend() {
    const backend = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: `${this.prefix}-jwks`,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        static: { host: ENTRA_HOST, port: 443 },
        policies: { tls: { sni: ENTRA_HOST } },
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
                issuer: this.issuer,
                audiences: this.audiences,
                jwks: {
                  remote: {
                    backendRef: {
                      group: BACKEND_API_GROUP[this.edition],
                      kind: BACKEND_KIND[this.edition],
                      name: `${this.prefix}-jwks`,
                    },
                    cacheDuration: '5m',
                    jwksPath: `/${this.tenantId}/discovery/v2.0/keys`,
                  },
                },
              },
            ],
            mcp: {
              provider: 'Entra',
              // Entra has no Dynamic Client Registration - this makes the proxy's DCR
              // handler short-circuit with a mock response carrying this client_id
              // instead of proxying real DCR (same rationale as Okta's clientId above).
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
    this.log('Cleaning up mcp-eager-auth-entra feature...', 'info');
    // Policy coalescing (PolicyRegistry) renames the applied EnterpriseAgentgatewayPolicy to
    // <feature>-<targetRef name> (or merged-<features>-<targetRef name>), so the literal
    // this.prefix name doesn't exist on the cluster - delete by the feature label instead.
    await this.deleteByLabel('EnterpriseAgentgatewayPolicy', {
      'agentgateway.dev/feature': this.name,
    });
    await this.deleteResource(BACKEND_KIND[this.edition], `${this.prefix}-jwks`, this.namespace);
    this.log('mcp-eager-auth-entra feature cleaned up', 'success');
  }
}

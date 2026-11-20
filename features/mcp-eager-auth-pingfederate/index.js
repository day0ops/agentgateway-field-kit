import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { BACKEND_API_GROUP, BACKEND_KIND } from '../../src/lib/editions.js';

/**
 * MCP Eager-Auth (PingFederate) Feature
 *
 * Same "auth-only MCP" pattern as mcp-eager-auth-okta/entra/auth0 (see those
 * features' doc comments), but with no `provider` set at all. agentgateway's
 * built-in MCP-auth adapter only has first-class support for
 * Auth0/Keycloak/Okta/Descope/Authentik/Entra - there is no PingFederate
 * option - so this feature configures `traffic.jwtAuthentication.mcp` the
 * same way a customer without a Ping adapter has to today: issuer + jwks +
 * clientId, no provider.
 *
 * This is a deliberate live reproduction of a known gap, not a workaround:
 * PingFederate's `/.well-known/oauth-authorization-server` still advertises
 * its own `registration_endpoint`, and with no provider set the gateway does
 * not rewrite or suppress it (the rewrite only happens inside the adapters
 * listed above). If PingFederate's tenant has no usable Dynamic Client
 * Registration endpoint (true of most PingFederate deployments, which expect
 * pre-registered clients), a client that follows the metadata literally -
 * same as this feature's `authorization-server-metadata-discoverable` test
 * does - gets PingFederate's own registration endpoint back, not the
 * gateway's working mock-DCR short-circuit at `.../client-registration`.
 * `clientId` below still lets a human complete a real login by skipping DCR
 * entirely (see the usecase's browser-login test), since PingFederate's
 * `authorization_endpoint`/`token_endpoint` pass through unmodified.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/mcp/auth/setup/
 *
 * Configuration:
 * {
 *   name: string,               // Resource name prefix (default: 'mcp-eager-auth-pingfederate')
 *   issuer: string,             // PingFederate issuer URL, e.g. 'https://<host>/as' (required)
 *   jwksPath: string,           // JWKS path relative to issuer, e.g. '/pf/JWKS' (required)
 *   clientId: string,           // Pre-registered app client ID - doubles as the mock-DCR
 *                               // client_id (required; default: PINGFEDERATE_ISSUER_CLIENT_ID env var)
 *   audiences: string[],        // Expected token audiences (default: [])
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
export class McpEagerAuthPingFederateFeature extends Feature {
  static SUPPORTED_EDITIONS = ['enterprise'];

  get prefix() {
    return this.config.name || 'mcp-eager-auth-pingfederate';
  }

  get issuer() {
    return this.config.issuer;
  }

  get issuerHost() {
    return this.issuer ? new URL(this.issuer).hostname : undefined;
  }

  get issuerPort() {
    if (!this.issuer) return 443;
    const { port, protocol } = new URL(this.issuer);
    return port ? Number(port) : protocol === 'http:' ? 80 : 443;
  }

  get jwksPath() {
    return this.config.jwksPath;
  }

  get clientId() {
    return this.config.clientId || process.env.PINGFEDERATE_ISSUER_CLIENT_ID || '';
  }

  get audiences() {
    // The CRD rejects an empty array (MinItems: 1) even though the field is optional -
    // default to the clientId, which matches the Audience Claim Value the
    // pingfederate addon's Access Token Manager actually issues (confirmed live).
    return this.config.audiences || (this.clientId ? [this.clientId] : []);
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
    if (!this.issuer) throw new Error('mcp-eager-auth-pingfederate requires issuer in config');
    if (!this.jwksPath) throw new Error('mcp-eager-auth-pingfederate requires jwksPath in config');
    // clientId is only needed to complete a real PingFederate login - the 401/discovery
    // behavior this usecase's automated tests check works without it. Require it for a
    // real deploy, but not for dry-run.
    if (!this.dryRun && !this.clientId) {
      throw new Error(
        'mcp-eager-auth-pingfederate requires clientId in config (or PINGFEDERATE_ISSUER_CLIENT_ID) for a real deploy'
      );
    }

    this.log('Deploying MCP eager-auth (PingFederate) infrastructure...', 'info');

    await this.deployPingFederateJwksBackend();
    await this.deployMcpAuthPolicy();
    await this.deployDiscoveryRoute();

    this.log('MCP eager-auth (PingFederate) deployed', 'success');
  }

  async deployPingFederateJwksBackend() {
    const backend = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: `${this.prefix}-jwks`,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        static: { host: this.issuerHost, port: this.issuerPort },
        // PingFederate's devops image serves a self-signed cert with no trusted CA
        // chain - insecureSkipVerify is required, unlike the Okta/Entra/Auth0
        // features' real publicly-trusted-CA domains.
        policies: { tls: { sni: this.issuerHost, insecureSkipVerify: 'All' } },
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
                    jwksPath: this.jwksPath,
                  },
                },
              },
            ],
            mcp: {
              // No `provider` - PingFederate has no first-class adapter (see the doc
              // comment above). clientId still short-circuits the gateway's own
              // /client-registration endpoint; the served discovery metadata just
              // doesn't advertise it, so a client that follows the metadata (instead
              // of being handed the ID directly) hits PingFederate's own, usually
              // non-functional, registration_endpoint instead.
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
    this.log('Cleaning up mcp-eager-auth-pingfederate feature...', 'info');
    // Policy coalescing (PolicyRegistry) renames the applied EnterpriseAgentgatewayPolicy to
    // <feature>-<targetRef name> (or merged-<features>-<targetRef name>), so the literal
    // this.prefix name doesn't exist on the cluster - delete by the feature label instead.
    await this.deleteByLabel('EnterpriseAgentgatewayPolicy', {
      'agentgateway.dev/feature': this.name,
    });
    await this.deleteResource(BACKEND_KIND[this.edition], `${this.prefix}-jwks`, this.namespace);
    this.log('mcp-eager-auth-pingfederate feature cleaned up', 'success');
  }
}

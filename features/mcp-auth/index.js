import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';
import {
  policyApiVersion,
  POLICY_KIND,
  BACKEND_API_GROUP,
  BACKEND_KIND,
} from '../../src/lib/editions.js';

/**
 * MCP Auth Feature
 *
 * Secures an MCP backend with OAuth 2.0 authentication using agentgateway
 * and Keycloak as the identity provider. MCP clients dynamically register
 * with the IdP to obtain a client ID, then use the OAuth flow to acquire a
 * JWT that grants access to the MCP server's tools.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/mcp/auth/setup/
 *
 * This feature:
 * - Optionally configures Keycloak for dynamic client registration
 *   (removes trusted-hosts and allowed-client-templates policies)
 * - Creates a policy with the MCP OAuth authentication config (issuer, JWKS,
 *   audiences, mode, provider, resourceMetadata), using `traffic.jwtAuthentication`
 *   + its `mcp` extension field, targeting the mcp-server feature's HTTPRoute, on
 *   both editions (EnterpriseAgentgatewayPolicy/enterprise, AgentgatewayPolicy/
 *   opensource - see POLICY_KIND in src/lib/editions.js). `backend.mcp.authentication`
 *   (targeting the backend) is deprecated in favor of this route-level shape, per
 *   Solo's API reference - and on opensource, the CRD schema rejects `traffic`
 *   targeting anything but Gateway/HTTPRoute/GRPCRoute/ListenerSet/InferencePool
 *   outright, so backend-targeting isn't even a schema-valid alternative there.
 * - Creates/updates the HTTPRoute to include OAuth discovery paths and CORS.
 *   CORS requires Gateway API experimental CRDs and
 *   controller.extraEnv.KGW_ENABLE_GATEWAY_API_EXPERIMENTAL_FEATURES=true.
 *
 * Configuration:
 * {
 *   policyName: string,                   // Default: 'mcp-auth'
 *   backendName: string,                  // Backend to protect (default: 'mcp-backend')
 *   routeName: string,                    // HTTPRoute name (default: 'mcp')
 *   mcpPath: string,                      // MCP endpoint path (default: '/mcp')
 *   keycloak: {
 *     realm: string,                      // Default: 'agw-dev'
 *     serviceName: string,                // Default: 'keycloak'
 *     serviceNamespace: string,           // Default: 'keycloak'
 *     servicePort: number,                // Default: 443
 *     jwksPath: string,                   // Default: 'realms/<realm>/protocol/openid-connect/certs'
 *     configureDynamicRegistration: bool, // Remove registration policies (default: true) - needs
 *                                         // KEYCLOAK_ADMIN_USERNAME / KEYCLOAK_ADMIN_PASSWORD env vars
 *     grantAudienceToClients: Array<string>, // Existing Keycloak client IDs to add this
 *                                         // usecase's `resource` as an audience mapper to - the
 *                                         // repo's generic pre-existing clients (agw-client,
 *                                         // agw-client-public) carry no audience by default (or
 *                                         // "account"), so a plain password-grant token from them
 *                                         // fails this policy's audience check otherwise. Dynamic
 *                                         // client registration doesn't need this: DCR-created
 *                                         // clients mint tokens with no `aud` claim at all, which
 *                                         // this policy's audience check passes through. Default: [].
 *   },
 *   issuer: string,                       // Override OIDC issuer URL
 *   audiences: Array<string>,             // JWT audience restriction (default: [resource])
 *   mode: string,                         // JWT validation mode (default: 'Strict')
 *   provider: string,                     // IdP type (default: 'Keycloak')
 *   resource: string,                     // OAuth resource identifier (default: 'http://localhost:8080/mcp')
 *   scopesSupported: Array<string>,       // OAuth scopes (default: ['email'])
 *   bearerMethodsSupported: Array<string>,// Bearer token delivery methods (default: ['header','body','query'])
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
export class McpAuthFeature extends Feature {
  constructor(name, config) {
    super(name, config);

    this.policyName = config.policyName || 'mcp-auth';
    this.backendName = config.backendName || 'mcp-backend';
    this.routeName = config.routeName || 'mcp';
    this.mcpPath = config.mcpPath || '/mcp';

    const kc = config.keycloak || {};
    this.realm = kc.realm || 'agw-dev';
    this.keycloakServiceName = kc.serviceName || 'keycloak';
    this.keycloakServiceNamespace = kc.serviceNamespace || 'keycloak';
    this.keycloakServicePort = kc.servicePort || 443;
    this.jwksPath = kc.jwksPath || `realms/${this.realm}/protocol/openid-connect/certs`;
    this.configureDynamicRegistration = kc.configureDynamicRegistration !== false;
    this.keycloakExternalUrl = kc.externalUrl || null;
    this.grantAudienceToClients = kc.grantAudienceToClients || [];

    const keycloakHost = `${this.keycloakServiceName}.${this.keycloakServiceNamespace}.svc.cluster.local`;
    const protocol =
      this.keycloakServicePort === 443 || this.keycloakServicePort === 8443 ? 'https' : 'http';
    // When externalUrl is set, Keycloak uses it as KC_HOSTNAME so tokens carry
    // iss = <externalUrl>/realms/<realm>. Use that as the issuer to match.
    const issuerBase = this.keycloakExternalUrl || `${protocol}://${keycloakHost}`;
    this.issuer = config.issuer || `${issuerBase}/realms/${this.realm}`;

    this.resource = config.resource || 'http://localhost:8080/mcp';
    this.audiences = config.audiences || [this.resource];
    this.mode = config.mode || 'Strict';
    this.provider = config.provider || 'Keycloak';
    this.scopesSupported = config.scopesSupported || ['email'];
    this.bearerMethodsSupported = config.bearerMethodsSupported || ['header', 'body', 'query'];

    const cors = config.cors || {};
    this.corsEnabled = cors.enabled !== false;
    this.corsAllowOrigins = cors.allowOrigins || ['*'];
    this.corsAllowMethods = cors.allowMethods || ['*'];
    this.corsAllowHeaders = cors.allowHeaders || ['Origin', 'Authorization', 'Content-Type'];
    this.corsExposeHeaders = cors.exposeHeaders || ['Origin', 'X-HTTPRoute-Header'];
    this.corsMaxAge = cors.maxAge || 86400;

    this.adminUsername = process.env.KEYCLOAK_ADMIN_USERNAME || '';
    this.adminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD || '';
  }

  getFeaturePath() {
    return 'mcp-auth';
  }

  validate() {
    if (!this.backendName) {
      throw new Error('MCP auth requires a backendName (backend to protect)');
    }
    return true;
  }

  async deploy() {
    this.log('Configuring MCP auth...', 'info');

    if (this.keycloakServicePort === 443 || this.keycloakServicePort === 8443) {
      await this.deployBackendTlsPolicy();
    }

    if (this.configureDynamicRegistration && !this.dryRun) {
      await this.configureKeycloakDynamicRegistration();
    }

    if (this.grantAudienceToClients.length > 0 && !this.dryRun) {
      await this.grantAudienceMappers();
    }

    await this.deployMcpAuthPolicy();
    await this.deployDiscoveryRoute();

    this.log('MCP auth policy applied', 'success');
  }

  async deployBackendTlsPolicy() {
    const tlsPolicyName = `${this.keycloakServiceName}-backend-tls`;
    this.log(`Applying backend TLS policy '${tlsPolicyName}'...`, 'info');

    const tlsPolicy = {
      apiVersion: policyApiVersion(this.edition),
      kind: POLICY_KIND[this.edition],
      metadata: {
        name: tlsPolicyName,
        namespace: this.keycloakServiceNamespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        targetRefs: [
          {
            group: '',
            kind: 'Service',
            name: this.keycloakServiceName,
          },
        ],
        backend: {
          tls: {
            insecureSkipVerify: 'All',
          },
        },
      },
    };

    await this.applyResource(tlsPolicy);
  }

  get keycloakAdminBaseUrl() {
    const protocol =
      this.keycloakServicePort === 443 || this.keycloakServicePort === 8443 ? 'https' : 'http';
    const internalBaseUrl = `${protocol}://${this.keycloakServiceName}.${this.keycloakServiceNamespace}.svc.cluster.local`;
    return this.keycloakExternalUrl || internalBaseUrl;
  }

  get useDirectKeycloakCurl() {
    return !!this.keycloakExternalUrl;
  }

  async runKeycloakAdminCurl(curlCmd) {
    if (this.useDirectKeycloakCurl) {
      return CommandRunner.exec(curlCmd, { ignoreError: true });
    }
    return CommandRunner.run(
      'kubectl',
      ['-n', this.keycloakServiceNamespace, 'exec', 'deploy/keycloak', '--', 'bash', '-c', curlCmd],
      { ignoreError: true }
    );
  }

  async getKeycloakAdminToken(adminBaseUrl) {
    // encodeURIComponent leaves ' unescaped, which would break out of the -d '...'
    // shell quoting below, so it's stripped separately.
    const username = encodeURIComponent(this.adminUsername).replace(/'/g, '%27');
    const password = encodeURIComponent(this.adminPassword).replace(/'/g, '%27');
    const result = await this.runKeycloakAdminCurl(
      `curl -sSfk -X POST ${adminBaseUrl}/realms/master/protocol/openid-connect/token ` +
        `-H 'Content-Type: application/x-www-form-urlencoded' ` +
        `-d 'username=${username}&password=${password}&grant_type=password&client_id=admin-cli'`
    );
    if (!result.stdout) return null;
    try {
      return JSON.parse(result.stdout).access_token || null;
    } catch {
      return null;
    }
  }

  async configureKeycloakDynamicRegistration() {
    this.log('Configuring Keycloak for dynamic client registration...', 'info');

    const adminBaseUrl = this.keycloakAdminBaseUrl;
    let token;
    try {
      token = await this.getKeycloakAdminToken(adminBaseUrl);
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

    await this.removeRegistrationPolicy(adminBaseUrl, token, 'trusted-hosts', null);
    await this.removeRegistrationPolicy(
      adminBaseUrl,
      token,
      'allowed-client-templates',
      'anonymous'
    );

    this.log('Keycloak dynamic client registration configured', 'info');
  }

  async removeRegistrationPolicy(baseUrl, token, providerId, subType) {
    try {
      const listResult = await this.runKeycloakAdminCurl(
        `curl -sSfk -H 'Authorization: Bearer ${token}' ` +
          `'${baseUrl}/admin/realms/${this.realm}/components?type=org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy'`
      );

      if (!listResult.stdout) return;

      const policies = JSON.parse(listResult.stdout);
      const match = policies.find(p => {
        if (p.providerId !== providerId) return false;
        if (subType && p.subType !== subType) return false;
        return true;
      });

      if (!match) return;

      await this.runKeycloakAdminCurl(
        `curl -sSfk -X DELETE -H 'Authorization: Bearer ${token}' ` +
          `'${baseUrl}/admin/realms/${this.realm}/components/${match.id}'`
      );

      this.log(`Removed Keycloak registration policy '${providerId}'`, 'info');
    } catch {
      this.log(`Could not remove Keycloak registration policy '${providerId}'`, 'warn');
    }
  }

  async grantAudienceMappers() {
    this.log(
      `Granting audience '${this.resource}' to client(s): ${this.grantAudienceToClients.join(', ')}...`,
      'info'
    );

    const adminBaseUrl = this.keycloakAdminBaseUrl;
    let token;
    try {
      token = await this.getKeycloakAdminToken(adminBaseUrl);
    } catch {
      this.log('Could not obtain Keycloak admin token for audience mapper setup', 'warn');
      return;
    }

    if (!token) {
      this.log('Could not obtain Keycloak admin token, skipping audience mapper setup', 'warn');
      return;
    }

    for (const clientId of this.grantAudienceToClients) {
      await this.grantAudienceMapper(adminBaseUrl, token, clientId);
    }
  }

  async grantAudienceMapper(baseUrl, token, clientId) {
    try {
      const lookupResult = await this.runKeycloakAdminCurl(
        `curl -sSfk -H 'Authorization: Bearer ${token}' ` +
          `'${baseUrl}/admin/realms/${this.realm}/clients?clientId=${encodeURIComponent(clientId)}'`
      );
      if (!lookupResult.stdout) return;

      const clients = JSON.parse(lookupResult.stdout);
      if (!clients.length) {
        this.log(`Keycloak client '${clientId}' not found, skipping audience mapper`, 'warn');
        return;
      }
      const clientInternalId = clients[0].id;

      const mapperName = `audience-${this.resource}`;
      const mappersResult = await this.runKeycloakAdminCurl(
        `curl -sSfk -H 'Authorization: Bearer ${token}' ` +
          `'${baseUrl}/admin/realms/${this.realm}/clients/${clientInternalId}/protocol-mappers/models'`
      );
      const mappers = mappersResult.stdout ? JSON.parse(mappersResult.stdout) : [];
      if (mappers.some(m => m.name === mapperName)) {
        this.log(`Audience mapper already present on client '${clientId}', skipping`, 'info');
        return;
      }

      const mapperBody = JSON.stringify({
        name: mapperName,
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: {
          'included.custom.audience': this.resource,
          'access.token.claim': 'true',
          'id.token.claim': 'false',
        },
      }).replace(/'/g, "'\\''");

      await this.runKeycloakAdminCurl(
        `curl -sSfk -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' ` +
          `-d '${mapperBody}' ` +
          `'${baseUrl}/admin/realms/${this.realm}/clients/${clientInternalId}/protocol-mappers/models'`
      );

      this.log(`Audience '${this.resource}' granted to client '${clientId}'`, 'info');
    } catch (error) {
      this.log(`Could not grant audience to client '${clientId}': ${error.message}`, 'warn');
    }
  }

  async deployMcpAuthPolicy() {
    if (this.edition === 'opensource') {
      return this.deployMcpAuthPolicyOpensource();
    }

    const policy = {
      apiVersion: policyApiVersion('enterprise'),
      kind: POLICY_KIND.enterprise,
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
            group: 'gateway.networking.k8s.io',
            kind: 'HTTPRoute',
            name: this.routeName,
          },
        ],
        traffic: {
          jwtAuthentication: {
            mode: this.mode,
            providers: [
              {
                issuer: this.issuer,
                audiences: this.audiences,
                jwks: {
                  remote: {
                    backendRef: {
                      name: this.keycloakServiceName,
                      kind: 'Service',
                      namespace: this.keycloakServiceNamespace,
                      port: this.keycloakServicePort,
                    },
                    jwksPath: `/${this.jwksPath}`,
                  },
                },
              },
            ],
            mcp: {
              provider: this.provider,
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
    this.log(
      `EnterpriseAgentgatewayPolicy '${this.policyName}' targeting HTTPRoute '${this.routeName}'`,
      'info'
    );
  }

  async deployMcpAuthPolicyOpensource() {
    const policy = {
      apiVersion: policyApiVersion('opensource'),
      kind: POLICY_KIND.opensource,
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
            group: 'gateway.networking.k8s.io',
            kind: 'HTTPRoute',
            name: this.routeName,
          },
        ],
        traffic: {
          jwtAuthentication: {
            mode: this.mode,
            providers: [
              {
                issuer: this.issuer,
                audiences: this.audiences,
                jwks: {
                  remote: {
                    backendRef: {
                      name: this.keycloakServiceName,
                      kind: 'Service',
                      namespace: this.keycloakServiceNamespace,
                      port: this.keycloakServicePort,
                    },
                    jwksPath: `/${this.jwksPath}`,
                  },
                },
              },
            ],
            mcp: {
              provider: this.provider,
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
    this.log(
      `AgentgatewayPolicy '${this.policyName}' targeting HTTPRoute '${this.routeName}'`,
      'info'
    );
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
        { path: { type: 'PathPrefix', value: `/${this.jwksPath}` } },
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
        rules: [rule],
      },
    };

    await this.applyResource(route);
    this.log(`HTTPRoute '${this.routeName}' updated with MCP auth discovery paths`, 'info');
  }

  async cleanup() {
    this.log('Cleaning up MCP auth...', 'info');

    const kind = POLICY_KIND[this.edition];
    await this.deleteResource(kind, this.policyName);
    await this.deleteResource(
      kind,
      `${this.keycloakServiceName}-backend-tls`,
      this.keycloakServiceNamespace
    );

    if (this.grantAudienceToClients.length > 0 && !this.dryRun) {
      await this.revokeAudienceMappers();
    }

    this.log('MCP auth cleaned up', 'success');
  }

  async revokeAudienceMappers() {
    const adminBaseUrl = this.keycloakAdminBaseUrl;
    let token;
    try {
      token = await this.getKeycloakAdminToken(adminBaseUrl);
    } catch {
      return;
    }
    if (!token) return;

    for (const clientId of this.grantAudienceToClients) {
      await this.revokeAudienceMapper(adminBaseUrl, token, clientId);
    }
  }

  async revokeAudienceMapper(baseUrl, token, clientId) {
    try {
      const lookupResult = await this.runKeycloakAdminCurl(
        `curl -sSfk -H 'Authorization: Bearer ${token}' ` +
          `'${baseUrl}/admin/realms/${this.realm}/clients?clientId=${encodeURIComponent(clientId)}'`
      );
      if (!lookupResult.stdout) return;

      const clients = JSON.parse(lookupResult.stdout);
      if (!clients.length) return;
      const clientInternalId = clients[0].id;

      const mapperName = `audience-${this.resource}`;
      const mappersResult = await this.runKeycloakAdminCurl(
        `curl -sSfk -H 'Authorization: Bearer ${token}' ` +
          `'${baseUrl}/admin/realms/${this.realm}/clients/${clientInternalId}/protocol-mappers/models'`
      );
      const mappers = mappersResult.stdout ? JSON.parse(mappersResult.stdout) : [];
      const match = mappers.find(m => m.name === mapperName);
      if (!match) return;

      await this.runKeycloakAdminCurl(
        `curl -sSfk -X DELETE -H 'Authorization: Bearer ${token}' ` +
          `'${baseUrl}/admin/realms/${this.realm}/clients/${clientInternalId}/protocol-mappers/models/${match.id}'`
      );

      this.log(`Audience '${this.resource}' revoked from client '${clientId}'`, 'info');
    } catch {
      // best-effort cleanup - a shared client may already be gone or unreachable
    }
  }
}

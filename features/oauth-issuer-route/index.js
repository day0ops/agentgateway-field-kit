import { Feature } from '../../src/lib/feature.js';
import { EDITION_GATEWAY_NAME, BACKEND_API_GROUP, BACKEND_KIND } from '../../src/lib/editions.js';

const CONTROLLER_PORT = 7777;

/**
 * OAuth Issuer Route Feature
 *
 * Wires a plain HTTP route to the enterprise-agentgateway controller's own OAuth
 * authorization server (port 7777, KGW_OAUTH_ISSUER_CONFIG - see the token-exchange
 * feature). auth-only-mcp is currently the only consumer - mcp-eager-auth-okta/-auth0/
 * -entra deliberately don't use this (see their own doc comments: the controller's
 * resource index only recognizes the deprecated backend.mcp.authentication shape, so a
 * real controller-brokered authorize request 400s for anything declared the
 * traffic.jwtAuthentication.mcp way, which is why they bypass the controller entirely).
 *
 * Configuration:
 * {
 *   gatewayName: string,  // Gateway to attach the route to (default: edition default)
 *   routeName: string,    // HTTPRoute name (default: 'oauth-issuer')
 *   backendName: string,  // AgentgatewayBackend name (default: 'oauth-issuer-backend')
 *   pathPrefix: string,   // Route path prefix (default: '/oauth-issuer')
 * }
 */
export class OauthIssuerRouteFeature extends Feature {
  static SUPPORTED_EDITIONS = ['enterprise'];

  get gatewayName() {
    return this.config.gatewayName || EDITION_GATEWAY_NAME[this.edition];
  }

  get routeName() {
    return this.config.routeName || 'oauth-issuer';
  }

  get backendName() {
    return this.config.backendName || 'oauth-issuer-backend';
  }

  get pathPrefix() {
    return this.config.pathPrefix || '/oauth-issuer';
  }

  get labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
    };
  }

  async deploy() {
    const backend = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: this.backendName,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        static: {
          host: `enterprise-agentgateway.${this.namespace}.svc.cluster.local`,
          port: CONTROLLER_PORT,
        },
      },
    };
    await this.applyResource(backend);

    const route = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        parentRefs: [{ name: this.gatewayName, namespace: this.namespace }],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: this.pathPrefix } }],
            backendRefs: [
              {
                group: BACKEND_API_GROUP[this.edition],
                kind: BACKEND_KIND[this.edition],
                name: this.backendName,
              },
            ],
          },
        ],
      },
    };
    await this.applyResource(route);
    this.log(`'${this.routeName}' route wired to the controller (port ${CONTROLLER_PORT})`, 'info');
  }

  async cleanup() {
    await this.deleteResource('HTTPRoute', this.routeName);
    await this.deleteResource(BACKEND_KIND[this.edition], this.backendName);
    this.log(`'${this.routeName}' route and '${this.backendName}' backend removed`, 'info');
  }
}

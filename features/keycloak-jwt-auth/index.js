import { Feature } from '../../src/lib/feature.js';
import {
  policyApiVersion,
  POLICY_KIND,
  EDITION_GATEWAY_NAME,
  BACKEND_API_GROUP,
  BACKEND_KIND,
} from '../../src/lib/editions.js';

const DEFAULT_KEYCLOAK_REALM = 'agw-dev';
const DEFAULT_AUDIENCES = ['account'];
const DEFAULT_CLAIM_HEADERS = [
  { claim: 'org_id', header: 'x-gw-org-id' },
  { claim: 'team_id', header: 'x-gw-team-id' },
];

/**
 * Keycloak JWT Auth Feature
 *
 * Validates Keycloak JWTs at the gateway in strict mode, then projects one or
 * more JWT claims into headers for downstream policies/services to consume.
 * Defaults to org_id/team_id -> x-gw-org-id/x-gw-team-id (unchanged behavior);
 * pass claimHeaders to project different claims instead (e.g. preferred_username
 * -> x-user-id for identity-based ext_authz backends).
 *
 * Configuration:
 * {
 *   keycloakHost: string,   // Keycloak domain, e.g. keycloak.demo.example.com (required)
 *   keycloakRealm: string,  // Keycloak realm (default: 'agw-dev')
 *   audiences: string[],    // Expected audiences (default: ['account'])
 *   gatewayName: string,    // Gateway resource name (default: EDITION_GATEWAY_NAME for this.edition)
 *   claimHeaders: Array<{ claim: string, header: string, fallback?: string }>,
 *     // JWT claim -> header projections (default: org_id/team_id -> x-gw-org-id/x-gw-team-id).
 *     // `fallback` is a CEL expression used when the JWT claim is absent, e.g. `"apiKey['user_id']"`
 *     // to fall back to an API key's identity on a route that accepts both auth methods
 *     // (requires mode: 'Optional' - see below - so a request without a JWT isn't rejected
 *     // before it gets a chance to authenticate via the other method).
 *   targetRefs: Array<{ group?: string, kind?: string, name: string }>, // Default: the Gateway
 *   mode: string,  // jwtAuthentication.mode: 'Strict' (default, unchanged) | 'Optional' |
 *                  // 'Permissive'. Use 'Optional' to let a route also accept a different auth
 *                  // method (e.g. an API key) for other callers.
 * }
 */
export class KeycloakJwtAuthFeature extends Feature {
  get keycloakHost() {
    return this.config.keycloakHost;
  }

  get keycloakRealm() {
    return this.config.keycloakRealm || DEFAULT_KEYCLOAK_REALM;
  }

  get audiences() {
    return this.config.audiences || DEFAULT_AUDIENCES;
  }

  get gatewayName() {
    return this.config.gatewayName || EDITION_GATEWAY_NAME[this.edition];
  }

  get claimHeaders() {
    return this.config.claimHeaders || DEFAULT_CLAIM_HEADERS;
  }

  get mode() {
    return this.config.mode || 'Strict';
  }

  /**
   * Defaults to the Gateway (unchanged behavior) when no targetRefs are given; pass explicit
   * targetRefs pointing at specific HTTPRoute(s) to scope JWT enforcement to just those routes
   * instead of the whole Gateway. Note: policy fields merge additively across attachment
   * levels - a Gateway-level jwtAuthentication is NOT cleared by a Route-level policy that
   * simply omits it, so routes meant to stay JWT-free (e.g. an API-key-only automation route)
   * must be excluded here rather than relying on omission at the route level.
   */
  get targetRefs() {
    if (this.config.targetRefs) {
      return this.config.targetRefs.map(ref => ({
        group: ref.group || 'gateway.networking.k8s.io',
        kind: ref.kind || 'Gateway',
        name: ref.name,
      }));
    }
    return [
      {
        group: 'gateway.networking.k8s.io',
        kind: 'Gateway',
        name: this.gatewayName,
      },
    ];
  }

  /**
   * `traffic.phase: PreRouting` is only valid when targeting a Gateway/ListenerSet/Service/
   * ServiceEntry - the CRD's admission webhook rejects it on an HTTPRoute target (confirmed via
   * a live deploy attempt). Route-scoped policies must omit `phase` entirely.
   */
  get targetsGatewayOnly() {
    return this.targetRefs.every(ref => ref.kind === 'Gateway');
  }

  getFeaturePath() {
    return 'keycloak-jwt-auth';
  }

  async deploy() {
    if (!this.keycloakHost) {
      throw new Error('KeycloakJwtAuthFeature requires keycloakHost in config');
    }

    this.log('Deploying Keycloak JWT auth feature...', 'info');
    await this.deployKeycloakJwksBackend();
    await this.deployJwtPolicy();
    this.log('Keycloak JWT auth feature deployed', 'success');
  }

  async deployKeycloakJwksBackend() {
    const backend = {
      apiVersion: `${BACKEND_API_GROUP[this.edition]}/v1alpha1`,
      kind: BACKEND_KIND[this.edition],
      metadata: {
        name: 'keycloak-jwks',
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': 'keycloak-jwt-auth',
        },
      },
      spec: {
        policies: {
          tls: {
            sni: this.keycloakHost,
          },
        },
        static: {
          host: this.keycloakHost,
          port: 443,
        },
      },
    };

    await this.applyResource(backend);
  }

  async deployJwtPolicy() {
    const issuer = `https://${this.keycloakHost}/realms/${this.keycloakRealm}`;

    const policy = {
      apiVersion: policyApiVersion(this.edition),
      kind: POLICY_KIND[this.edition],
      metadata: {
        name: 'keycloak-jwt-auth',
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': 'keycloak-jwt-auth',
        },
      },
      spec: {
        targetRefs: this.targetRefs,
        traffic: {
          ...(this.targetsGatewayOnly ? { phase: 'PreRouting' } : {}),
          jwtAuthentication: {
            mode: this.mode,
            providers: [
              {
                issuer,
                audiences: this.audiences,
                jwks: {
                  remote: {
                    jwksPath: `realms/${this.keycloakRealm}/protocol/openid-connect/certs`,
                    cacheDuration: '5m',
                    backendRef: {
                      group: BACKEND_API_GROUP[this.edition],
                      kind: BACKEND_KIND[this.edition],
                      name: 'keycloak-jwks',
                      namespace: this.namespace,
                    },
                  },
                },
              },
            ],
          },
          transformation: {
            request: {
              set: this.claimHeaders.map(({ claim, header, fallback }) => ({
                name: header,
                value: fallback ? `coalesce(jwt['${claim}'], ${fallback})` : `jwt['${claim}']`,
              })),
            },
          },
        },
      },
    };

    await this.applyResource(policy);
  }

  async cleanup() {
    this.log('Cleaning up Keycloak JWT auth feature...', 'info');
    await this.deleteByLabel(BACKEND_KIND[this.edition], {
      'agentgateway.dev/feature': 'keycloak-jwt-auth',
    });
    await this.deleteByLabel(POLICY_KIND[this.edition], {
      'agentgateway.dev/feature': 'keycloak-jwt-auth',
    });
    this.log('Keycloak JWT auth feature cleaned up', 'success');
  }
}

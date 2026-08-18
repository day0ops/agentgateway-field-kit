import { Feature, FeatureManager } from '../../src/lib/feature.js';

/**
 * OPA Authz Feature
 *
 * Applies an EnterpriseAgentgatewayPolicy wiring agentgateway's ext_authz hook
 * to the OPA server deployed by addons/opa. Unlike features/openfga-authz,
 * no adapter Deployment is created here - OPA speaks the Envoy ext_authz gRPC
 * protocol natively (github.com/day0ops/opa-ext-authz), so this feature is
 * just the policy wiring.
 *
 * Configuration:
 * {
 *   policyName: string,       // default: 'opa-authz-policy'
 *   opaNamespace: string,     // default: 'opa' - where addons/opa deployed the OPA Service
 *   opaServiceName: string,   // default: 'opa'
 *   opaPort: number,          // default: 9191
 *   targetRefs: Array<{ group, kind, name }>,
 * }
 */
export class OpaAuthzFeature extends Feature {
  // ext_authz (EnterpriseAgentgatewayPolicy traffic.extAuth) has no OSS equivalent.
  static SUPPORTED_EDITIONS = ['enterprise'];

  constructor(name, config) {
    super(name, config);
    this.policyName = config.policyName || 'opa-authz-policy';
    this.opaNamespace = config.opaNamespace || 'opa';
    this.opaServiceName = config.opaServiceName || 'opa';
    this.opaPort = config.opaPort || 9191;
    this.targetRefs = config.targetRefs || null;
  }

  getFeaturePath() {
    return 'opa-authz';
  }

  validate() {
    return true;
  }

  async deploy() {
    this.log('Configuring OPA ext-authz...', 'info');
    await this.deployExtAuthPolicy();
    this.log('OPA ext-authz policy applied', 'success');
  }

  async deployExtAuthPolicy() {
    const gatewayRef = FeatureManager.getGatewayRef();

    // Defaults to the Gateway when no targetRefs are given; pass explicit
    // targetRefs pointing at specific HTTPRoute(s) to avoid PolicyRegistry
    // merging this with a Gateway-level PreRouting policy (e.g. providers'
    // body-routing policy) that this doesn't need to share a phase with.
    const targetRefs = this.targetRefs || [
      { group: 'gateway.networking.k8s.io', kind: 'Gateway', name: gatewayRef.name },
    ];

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
        targetRefs,
        traffic: {
          extAuth: {
            backendRef: {
              name: this.opaServiceName,
              namespace: this.opaNamespace,
              port: this.opaPort,
            },
            grpc: {},
            forwardBody: {
              maxSize: 8192,
            },
          },
        },
      },
    };

    await this.applyResource(policy);
    this.log(
      `EnterpriseAgentgatewayPolicy '${this.policyName}' → ${this.opaServiceName}.${this.opaNamespace}:${this.opaPort} ` +
        `(targeting ${targetRefs.map(r => r.name).join(', ')})`,
      'info'
    );
  }

  async cleanup() {
    this.log('Cleaning up OPA ext-authz...', 'info');
    await this.deleteResource('EnterpriseAgentgatewayPolicy', this.policyName);
    this.log('OPA ext-authz cleaned up', 'success');
  }
}

export function createOpaAuthzFeature(config) {
  return new OpaAuthzFeature('opa-authz', config);
}

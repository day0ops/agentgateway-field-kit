import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';

const DEFAULT_ADAPTER_IMAGE =
  'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/openfga-ext-authz:latest';
const BOOTSTRAP_CONFIGMAP_NAME = 'openfga-bootstrap';

/**
 * OpenFGA Authz Feature
 *
 * Wires an EnterpriseAgentgatewayPolicy to delegate authorization to a gRPC
 * ext_authz adapter (github.com/day0ops/openfga-ext-authz) backed by an
 * OpenFGA (ReBAC) server. Reads the storeId/modelId written by addons/openfga
 * to the 'openfga-bootstrap' ConfigMap, deploys the adapter, and applies the
 * policy.
 *
 * Reference: https://openfga.dev
 *
 * Configuration:
 * {
 *   policyName: string,            // default: 'openfga-authz-policy'
 *   adapterImage: string,          // default: '.../openfga-ext-authz:latest'
 *   adapterService: {
 *     name: string,                // default: 'openfga-ext-authz'
 *     namespace: string,           // default: this feature's namespace
 *     port: number,                // default: 9001
 *   },
 *   openfgaNamespace: string,      // default: 'openfga' - where the bootstrap ConfigMap/Service live
 *   openfgaServiceName: string,    // default: 'openfga'
 *   openfgaPort: number,           // default: 8080
 *   relation: string,              // default: 'can_use'
 *   userHeader: string,            // default: 'x-user-id'
 *   objectType: string,            // default: 'model'
 *   targetRefs: Array<{ group, kind, name }>,
 * }
 */
export class OpenfgaAuthzFeature extends Feature {
  // ext_authz (EnterpriseAgentgatewayPolicy traffic.extAuth) has no OSS equivalent.
  static SUPPORTED_EDITIONS = ['enterprise'];

  constructor(name, config) {
    super(name, config);
    this.policyName = config.policyName || 'openfga-authz-policy';
    this.adapterImage = config.adapterImage || DEFAULT_ADAPTER_IMAGE;

    const svc = config.adapterService || {};
    this.adapterServiceName = svc.name || 'openfga-ext-authz';
    this.adapterServiceNamespace = svc.namespace || this.namespace;
    this.adapterServicePort = svc.port || 9001;

    this.openfgaNamespace = config.openfgaNamespace || 'openfga';
    this.openfgaServiceName = config.openfgaServiceName || 'openfga';
    this.openfgaPort = config.openfgaPort || 8080;

    this.relation = config.relation || 'can_use';
    this.userHeader = config.userHeader || 'x-user-id';
    this.objectType = config.objectType || 'model';

    this.targetRefs = config.targetRefs || null;
  }

  getFeaturePath() {
    return 'openfga-authz';
  }

  validate() {
    return true;
  }

  async deploy() {
    this.log('Configuring OpenFGA ext-authz...', 'info');

    const { storeId, modelId } = await this.readBootstrapConfig();
    await this.deployAdapter(storeId, modelId);
    await this.deployExtAuthPolicy();

    this.log('OpenFGA ext-authz policy applied', 'success');
  }

  async readBootstrapConfig() {
    if (this.dryRun) {
      return { storeId: '<STORE_ID>', modelId: '<MODEL_ID>' };
    }

    const getField = async field => {
      const result = await KubernetesHelper.kubectl(
        [
          'get',
          'configmap',
          BOOTSTRAP_CONFIGMAP_NAME,
          '-n',
          this.openfgaNamespace,
          '-o',
          `jsonpath={.data.${field}}`,
        ],
        { ignoreError: true }
      );
      return (result.stdout || '').trim();
    };

    const storeId = await getField('storeId');
    const modelId = await getField('modelId');

    if (!storeId || !modelId) {
      throw new Error(
        `Could not read storeId/modelId from ConfigMap '${BOOTSTRAP_CONFIGMAP_NAME}' in namespace ` +
          `'${this.openfgaNamespace}' - ensure the 'openfga' addon is installed first ` +
          `(agw install --profile agentgateway-with-openfga).`
      );
    }

    return { storeId, modelId };
  }

  async deployAdapter(storeId, modelId) {
    const openfgaApiUrl = `http://${this.openfgaServiceName}.${this.openfgaNamespace}.svc.cluster.local:${this.openfgaPort}`;

    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: this.adapterServiceName,
        namespace: this.adapterServiceNamespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
          app: this.adapterServiceName,
        },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: this.adapterServiceName } },
        template: {
          metadata: { labels: { app: this.adapterServiceName } },
          spec: {
            containers: [
              {
                name: 'openfga-ext-authz',
                image: this.adapterImage,
                ports: [{ containerPort: this.adapterServicePort, name: 'grpc' }],
                env: [
                  { name: 'PORT', value: String(this.adapterServicePort) },
                  { name: 'OPENFGA_API_URL', value: openfgaApiUrl },
                  { name: 'OPENFGA_STORE_ID', value: storeId },
                  { name: 'OPENFGA_MODEL_ID', value: modelId },
                  { name: 'OPENFGA_RELATION', value: this.relation },
                  { name: 'USER_HEADER', value: this.userHeader },
                  { name: 'OBJECT_TYPE', value: this.objectType },
                ],
              },
            ],
          },
        },
      },
    };

    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: this.adapterServiceName,
        namespace: this.adapterServiceNamespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        selector: { app: this.adapterServiceName },
        ports: [
          { port: this.adapterServicePort, targetPort: this.adapterServicePort, name: 'grpc' },
        ],
      },
    };

    await this.applyResource(deployment);
    await this.applyResource(service);
    this.log(
      `OpenFGA ext-authz adapter '${this.adapterServiceName}' deployed (image: ${this.adapterImage})`,
      'info'
    );
  }

  async deployExtAuthPolicy() {
    const gatewayRef = FeatureManager.getGatewayRef();

    // Defaults to the Gateway (matching byo-ext-auth/apikey-auth's convention) when no
    // targetRefs are given. When paired with the providers feature's body-routing policy
    // (which also targets the Gateway, in PreRouting phase), pass explicit targetRefs
    // pointing at the specific HTTPRoute(s) instead - this keeps the two policies out of
    // PolicyRegistry's same-target merge, since ext_authz doesn't need or want to run in
    // PreRouting phase.
    const targetRefs = this.targetRefs || [
      {
        group: 'gateway.networking.k8s.io',
        kind: 'Gateway',
        name: gatewayRef.name,
      },
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
              name: this.adapterServiceName,
              namespace: this.adapterServiceNamespace,
              port: this.adapterServicePort,
            },
            // grpc selects the gRPC ext_authz variant; contextExtensions is left empty since
            // this adapter reads the user header and body directly rather than via context.
            // NOTE: this whole traffic.extAuth shape (backendRef/grpc/forwardBody) is ported
            // from a confirmed-working demo YAML, not from the CRD schema itself (unavailable
            // offline) - verify against `kubectl get crd
            // enterpriseagentgatewaypolicies.enterpriseagentgateway.solo.io -o yaml` once a
            // cluster is available.
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
      `EnterpriseAgentgatewayPolicy '${this.policyName}' → ${this.adapterServiceName}:${this.adapterServicePort} ` +
        `(targeting ${targetRefs.map(r => r.name).join(', ')})`,
      'info'
    );
  }

  async cleanup() {
    this.log('Cleaning up OpenFGA ext-authz...', 'info');
    await this.deleteResource('EnterpriseAgentgatewayPolicy', this.policyName);
    await this.deleteResource('Deployment', this.adapterServiceName, this.adapterServiceNamespace);
    await this.deleteResource('Service', this.adapterServiceName, this.adapterServiceNamespace);
    this.log('OpenFGA ext-authz cleaned up', 'success');
  }
}

export function createOpenfgaAuthzFeature(config) {
  return new OpenfgaAuthzFeature('openfga-authz', config);
}

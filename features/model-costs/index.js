import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';
import { readFile } from 'fs/promises';

const DEFAULT_CONFIGMAP_NAME = 'model-costs-catalog';
const DEFAULT_PARAMETERS_NAME = 'model-costs-params';
const DEFAULT_CATALOG_KEY = 'catalog.json';
const PARAMETERS_GROUP = 'enterpriseagentgateway.solo.io';
const PARAMETERS_KIND = 'EnterpriseAgentgatewayParameters';

/**
 * Model Costs Feature
 *
 * Implements Solo's native "Model costs" capability: a JSON price catalog stored in a
 * ConfigMap and referenced by a Gateway-level EnterpriseAgentgatewayParameters.spec.modelCatalog,
 * attached to the Gateway via spec.infrastructure.parametersRef. Gateway-level attachment only -
 * a GatewayClass-level parametersRef is ignored by the model catalog.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/llm/cost-controls/costs/
 *
 * Configuration:
 * {
 *   catalog: {                  // Inline catalog object. Mutually exclusive with catalogFile.
 *     providers: {
 *       <providerId>: {
 *         models: {
 *           <modelName>: {
 *             rates: {           // Strings (exact decimals), USD per 1,000,000 tokens
 *               input, output, cacheRead, cacheWrite, reasoning, inputAudio, outputAudio
 *             },
 *             tiers: [           // Optional, ascending by contextOver
 *               { contextOver: number, rates: { ... } }
 *             ]
 *           }
 *         }
 *       }
 *     }
 *   },
 *   catalogFile: string,        // Path to a JSON file with the same { providers: {...} } shape
 *   configMapName: string,      // Default: 'model-costs-catalog'
 *   parametersName: string,     // Default: 'model-costs-params'
 *   catalogKey: string,         // ConfigMap data key / configMap.key (default: 'catalog.json')
 *   gatewayName: string,        // Default: FeatureManager.getGatewayRef().name
 *   gatewayNamespace: string,   // Default: FeatureManager.getGatewayRef().namespace
 * }
 */
export class ModelCostsFeature extends Feature {
  // Enterprise-only: EnterpriseAgentgatewayParameters/modelCatalog has no OSS equivalent.
  static SUPPORTED_EDITIONS = ['enterprise'];

  constructor(name, config) {
    super(name, config);
    this.configMapName = config.configMapName || DEFAULT_CONFIGMAP_NAME;
    this.parametersName = config.parametersName || DEFAULT_PARAMETERS_NAME;
    this.catalogKey = config.catalogKey || DEFAULT_CATALOG_KEY;

    const gatewayRef = FeatureManager.getGatewayRef();
    this.gatewayName = config.gatewayName || gatewayRef.name;
    this.gatewayNamespace = config.gatewayNamespace || gatewayRef.namespace;
  }

  validate() {
    if (this.config.catalog && this.config.catalogFile) {
      throw new Error('model-costs: specify either catalog or catalogFile, not both');
    }
    if (!this.config.catalog && !this.config.catalogFile) {
      throw new Error('model-costs: either catalog or catalogFile is required');
    }
    if (this.config.catalog) {
      this._validateCatalog(this.config.catalog);
    }
    return true;
  }

  _validateCatalog(catalog) {
    const providers = catalog?.providers || {};
    for (const [providerId, provider] of Object.entries(providers)) {
      const models = provider?.models || {};
      for (const [modelName, model] of Object.entries(models)) {
        const tiers = model?.tiers;
        if (!tiers || tiers.length === 0) continue;
        for (let i = 1; i < tiers.length; i++) {
          if (tiers[i].contextOver <= tiers[i - 1].contextOver) {
            throw new Error(
              `model-costs: ${providerId}/${modelName} tiers must be ordered by ascending contextOver`
            );
          }
        }
      }
    }
  }

  async _loadCatalog() {
    if (this.config.catalogFile) {
      const content = await readFile(this.config.catalogFile, 'utf8');
      return JSON.parse(content);
    }
    return this.config.catalog;
  }

  async deploy() {
    this.log('Deploying model cost catalog...', 'info');

    const catalog = await this._loadCatalog();
    this._validateCatalog(catalog);

    await this._deployConfigMap(catalog);
    await this._deployParameters();
    await this._attachToGateway();

    this.log('Model costs deployed', 'success');
  }

  async _deployConfigMap(catalog) {
    const dataOverrides = { [this.catalogKey]: JSON.stringify(catalog, null, 2) };
    if (this.catalogKey !== DEFAULT_CATALOG_KEY) {
      dataOverrides[DEFAULT_CATALOG_KEY] = undefined;
    }

    await this.applyYamlFile('config-map.yaml', {
      metadata: { name: this.configMapName, namespace: this.namespace },
      data: dataOverrides,
    });
    this.log(`ConfigMap '${this.configMapName}' deployed`, 'info');
  }

  async _deployParameters() {
    await this.applyYamlFile('enterprise-agentgateway-parameters.yaml', {
      metadata: { name: this.parametersName, namespace: this.namespace },
      spec: {
        modelCatalog: {
          sources: [{ configMap: { name: this.configMapName, key: this.catalogKey } }],
        },
      },
    });
    this.log(`EnterpriseAgentgatewayParameters '${this.parametersName}' deployed`, 'info');
  }

  _buildParametersRefPatch(parametersRef) {
    return JSON.stringify({ spec: { infrastructure: { parametersRef } } });
  }

  // Uses a raw `kubectl patch --type=merge` instead of applyResource()/applyYamlFile() on
  // purpose: this feature doesn't own the Gateway (the 'gateway' feature or the default
  // Gateway does) and only needs to set one field on it. KubernetesHelper.applyYaml() does
  // `kubectl apply --server-side --force-conflicts` under one shared field manager for every
  // feature in this repo, so a partial Gateway document applied that way would be read as
  // "the desired state for every field this manager owns" and would prune whatever the
  // owning feature's own full apply set (listeners, TLS, etc). A merge patch only ever
  // touches the exact key path in the patch body, so it can't clobber unrelated fields.
  async _attachToGateway() {
    const parametersRef = {
      name: this.parametersName,
      group: PARAMETERS_GROUP,
      kind: PARAMETERS_KIND,
    };

    if (this.dryRun) {
      const patchCmd = `kubectl patch gateway ${this.gatewayName} -n ${this.gatewayNamespace} --type=merge -p '${this._buildParametersRefPatch(parametersRef)}'`;
      this._dryRunYaml.push(
        [
          '# --- Gateway patch (model-costs) ---',
          '# Attaches the model cost catalog to the Gateway via spec.infrastructure.parametersRef.',
          "# Can't safely preview a live patch without hitting the cluster during dry-run:",
          `# ${patchCmd}`,
        ].join('\n')
      );
      return;
    }

    await KubernetesHelper.kubectl([
      'patch',
      'gateway',
      this.gatewayName,
      '-n',
      this.gatewayNamespace,
      '--type=merge',
      '-p',
      this._buildParametersRefPatch(parametersRef),
    ]);
    this.log(
      `Gateway '${this.gatewayName}' attached to EnterpriseAgentgatewayParameters '${this.parametersName}'`,
      'info'
    );
  }

  async _detachFromGateway() {
    try {
      const result = await KubernetesHelper.kubectl(
        [
          'get',
          'gateway',
          this.gatewayName,
          '-n',
          this.gatewayNamespace,
          '-o',
          'jsonpath={.spec.infrastructure.parametersRef.name}',
        ],
        { ignoreError: true }
      );
      const currentRefName = (result.stdout || '').trim();
      if (currentRefName && currentRefName === this.parametersName) {
        await KubernetesHelper.kubectl(
          [
            'patch',
            'gateway',
            this.gatewayName,
            '-n',
            this.gatewayNamespace,
            '--type=merge',
            '-p',
            this._buildParametersRefPatch(null),
          ],
          { ignoreError: true }
        );
        this.log(`Gateway '${this.gatewayName}' parametersRef cleared`, 'info');
      }
    } catch {
      // Gateway may not exist anymore; nothing to detach
    }
  }

  async cleanup() {
    this.log('Cleaning up model cost catalog...', 'info');

    await this._detachFromGateway();
    await this.deleteResource(PARAMETERS_KIND, this.parametersName);
    await this.deleteResource('ConfigMap', this.configMapName);

    this.log('Model costs cleaned up', 'success');
  }
}

export function createModelCostsFeature(config) {
  return new ModelCostsFeature('model-costs', config);
}

import { Feature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, 'config');

const OPENFGA_VERSION = 'v1.10.3';
const OPENFGA_HTTP_PORT = 8080;
const STORE_NAME = 'agentgateway-demo';
const BOOTSTRAP_CONFIGMAP_NAME = 'openfga-bootstrap';
const PORT_FORWARD_LOCAL_PORT = 18099;

/**
 * Seed relationship tuples for the org/team/provider/model ReBAC demo.
 * Ported from agentgateway-demos/policy/openfga/relationships.py's
 * setup_demo_relationships_v3.
 *
 *   - alice, bob:  members of org:acme -> entitled to every model behind provider:openai
 *   - bob:         also a member of team:acme-ml -> allowlisted for claude-sonnet-5
 *   - dave:        provider-wide extra grant on provider:openai (independent of org/team)
 *   - erin:        direct per-user grant on model:gpt-4o
 *   - mcp-user:    direct per-user grant on model:gpt-4o only (not gpt-3.5-turbo)
 *   - team-ci:     direct per-user grant on model:gpt-4o-mini only - a service identity for
 *                  automation/CI traffic authenticated via API key rather than a human JWT
 *                  (see cost-management/tiered-cost-control)
 *   - charlie:     no tuples at all -> no access to anything
 */
const SEED_TUPLES = [
  { user: 'user:alice', relation: 'member', object: 'org:acme' },
  { user: 'user:bob', relation: 'member', object: 'org:acme' },

  { user: 'org:acme', relation: 'org', object: 'team:acme-ml' },
  { user: 'user:bob', relation: 'member', object: 'team:acme-ml' },

  { user: 'org:acme#member', relation: 'org_can_use', object: 'provider:openai' },
  { user: 'user:dave', relation: 'extra_can_use', object: 'provider:openai' },

  { user: 'provider:openai', relation: 'provider', object: 'model:gpt-4o' },
  { user: 'provider:openai', relation: 'provider', object: 'model:gpt-3.5-turbo' },
  { user: 'provider:openai', relation: 'provider', object: 'model:gpt-4o-mini' },
  { user: 'provider:anthropic', relation: 'provider', object: 'model:claude-sonnet-5' },

  { user: 'team:acme-ml', relation: 'team_allowed', object: 'model:claude-sonnet-5' },

  { user: 'user:erin', relation: 'direct', object: 'model:gpt-4o' },
  { user: 'user:mcp-user', relation: 'direct', object: 'model:gpt-4o' },
  { user: 'user:team-ci', relation: 'direct', object: 'model:gpt-4o-mini' },
];

/**
 * OpenFGA Feature (manifest-based, no Helm)
 *
 * Deploys OpenFGA (in-memory datastore) via raw Kubernetes manifests, then
 * bootstraps a store, authorization model, and seed relationship tuples via
 * its HTTP API (port-forwarded, since the Service is ClusterIP-only). Writes
 * the resulting storeId/modelId to a ConfigMap ('openfga-bootstrap') so
 * features/openfga-authz can read them back at usecase-deploy time.
 *
 * Reference: https://openfga.dev
 */
export class OpenfgaFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.openfgaVersion = config.version || OPENFGA_VERSION;
    this.openfgaImage = config.image || `openfga/openfga:${this.openfgaVersion}`;
    this.storeName = config.storeName || STORE_NAME;
    this.bootstrapConfigMapName = config.bootstrapConfigMapName || BOOTSTRAP_CONFIGMAP_NAME;
    this.servicePort = OPENFGA_HTTP_PORT;
  }

  getFeaturePath() {
    return 'openfga';
  }

  validate() {
    return true;
  }

  async deploy() {
    this.log('Installing OpenFGA...', 'info');

    await KubernetesHelper.ensureNamespace(this.namespace, this.spinner);
    await this.applyTemplate('openfga.yaml');
    await this.waitForOpenfga();

    if (this.dryRun) {
      await this.writeBootstrapConfigMap('<STORE_ID>', '<MODEL_ID>');
      this.log('OpenFGA installed successfully (dry run)', 'success');
      return;
    }

    await this.withPortForward(async baseUrl => {
      const storeId = await this.ensureStore(baseUrl);
      const modelId = await this.ensureAuthorizationModel(baseUrl, storeId);
      await this.writeSeedTuples(baseUrl, storeId, modelId);
      await this.writeBootstrapConfigMap(storeId, modelId);
    });

    this.log('OpenFGA installed successfully', 'success');
  }

  // ---------------------------------------------------------------------------
  // Template helpers
  // ---------------------------------------------------------------------------

  templateVars() {
    return {
      NAMESPACE: this.namespace,
      OPENFGA_IMAGE: this.openfgaImage,
    };
  }

  async applyTemplate(filename) {
    const raw = await readFile(join(CONFIG_DIR, filename), 'utf8');
    const vars = this.templateVars();
    const rendered = raw.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      if (vars[key] === undefined)
        throw new Error(`Unknown template variable: {{${key}}} in ${filename}`);
      return vars[key];
    });

    const docs = yaml.loadAll(rendered).filter(Boolean);
    for (const doc of docs) {
      await this.applyResource(doc);
    }
  }

  async waitForOpenfga() {
    this.log('Waiting for OpenFGA to be ready...', 'info');
    try {
      await KubernetesHelper.cleanupAndWaitForDeployment(
        this.namespace,
        'openfga',
        'app=openfga',
        180
      );
    } catch (error) {
      this.log(`OpenFGA may not be fully ready: ${error.message}`, 'warn');
    }
  }

  // ---------------------------------------------------------------------------
  // Bootstrap via OpenFGA HTTP API (port-forwarded - Service is ClusterIP-only)
  // ---------------------------------------------------------------------------

  async withPortForward(fn) {
    const localPort = PORT_FORWARD_LOCAL_PORT;
    const pfProc = spawn(
      'kubectl',
      ['port-forward', '-n', this.namespace, 'svc/openfga', `${localPort}:${this.servicePort}`],
      { stdio: 'pipe' }
    );

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenFGA port-forward timed out')), 15000);
      pfProc.stdout.on('data', data => {
        if (data.toString().includes('Forwarding from')) {
          clearTimeout(timer);
          resolve();
        }
      });
      pfProc.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      pfProc.on('close', code => {
        if (code !== null) {
          clearTimeout(timer);
          reject(new Error(`OpenFGA port-forward failed: exit code ${code}`));
        }
      });
    });

    try {
      return await fn(`http://localhost:${localPort}`);
    } finally {
      pfProc.kill();
      await new Promise(r => setTimeout(r, 100));
    }
  }

  async fgaApi(method, url, body) {
    const args = ['-sS', '-X', method, '-H', 'Content-Type: application/json'];
    if (body) args.push('-d', JSON.stringify(body));
    args.push(url);

    const result = await CommandRunner.run('curl', args, { ignoreError: true });
    if (result.exitCode !== 0) {
      throw new Error(
        `OpenFGA API ${method} ${url} failed (exit ${result.exitCode}): ${result.stderr || result.message || 'unknown error'}`
      );
    }
    if (!result.stdout) return {};
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`OpenFGA API ${method} ${url}: failed to parse response: ${error.message}`);
    }
  }

  async ensureStore(baseUrl) {
    const existingId = await this.findStoreByName(baseUrl, this.storeName);
    if (existingId) {
      this.log(`Reusing existing OpenFGA store '${this.storeName}' (${existingId})`, 'info');
      return existingId;
    }

    this.log(`Creating OpenFGA store '${this.storeName}'...`, 'info');
    const result = await this.fgaApi('POST', `${baseUrl}/stores`, { name: this.storeName });
    if (!result?.id) {
      throw new Error(`Failed to create OpenFGA store '${this.storeName}'`);
    }
    return result.id;
  }

  async findStoreByName(baseUrl, name) {
    const result = await this.fgaApi('GET', `${baseUrl}/stores?name=${encodeURIComponent(name)}`);
    const stores = result?.stores || [];
    return stores.find(s => s.name === name)?.id || null;
  }

  async ensureAuthorizationModel(baseUrl, storeId) {
    const existing = await this.fgaApi('GET', `${baseUrl}/stores/${storeId}/authorization-models`);
    const models = existing?.authorization_models || [];
    if (models.length > 0) {
      this.log(`Reusing existing OpenFGA authorization model (${models[0].id})`, 'info');
      return models[0].id;
    }

    this.log('Creating OpenFGA authorization model...', 'info');
    const modelJson = JSON.parse(
      await readFile(join(CONFIG_DIR, 'authorization-model.json'), 'utf8')
    );
    const result = await this.fgaApi(
      'POST',
      `${baseUrl}/stores/${storeId}/authorization-models`,
      modelJson
    );
    if (!result?.authorization_model_id) {
      throw new Error('Failed to create OpenFGA authorization model');
    }
    return result.authorization_model_id;
  }

  async writeSeedTuples(baseUrl, storeId, modelId) {
    this.log(`Writing ${SEED_TUPLES.length} seed relationship tuple(s)...`, 'info');
    await this.fgaApi('POST', `${baseUrl}/stores/${storeId}/write`, {
      writes: { tuple_keys: SEED_TUPLES, on_duplicate: 'ignore' },
      authorization_model_id: modelId,
    });
  }

  async writeBootstrapConfigMap(storeId, modelId) {
    await this.applyResource({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: this.bootstrapConfigMapName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      data: { storeId, modelId, storeName: this.storeName },
    });
    this.log(
      `ConfigMap '${this.bootstrapConfigMapName}' written (storeId=${storeId}, modelId=${modelId})`,
      'info'
    );
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  async cleanup() {
    this.log('Cleaning up OpenFGA...', 'info');
    await this.deleteResource('deployment', 'openfga');
    await this.deleteResource('service', 'openfga');
    await this.deleteResource('configmap', this.bootstrapConfigMapName);
    this.log('OpenFGA cleaned up', 'success');
  }
}

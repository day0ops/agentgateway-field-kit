import { Feature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, 'config');

const OPENFGA_CHART_REPO = 'https://openfga.github.io/helm-charts';
const OPENFGA_CHART_VERSION = '0.4.1';
const OPENFGA_VERSION = 'v1.22.1';
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
 * OpenFGA Feature (installed via OpenFGA's official Helm chart)
 *
 * Deploys OpenFGA (in-memory datastore) via its official Helm chart, then
 * bootstraps a store, authorization model, and seed relationship tuples via
 * its HTTP API (port-forwarded, since the Service is ClusterIP-only). Writes
 * the resulting storeId/modelId to a ConfigMap ('openfga-bootstrap') so
 * features/openfga-authz can read them back at usecase-deploy time.
 *
 * Reference: https://openfga.dev, https://github.com/openfga/helm-charts
 */
export class OpenfgaFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.openfgaVersion = config.version || OPENFGA_VERSION;
    this.openfgaImage = config.image || `openfga/openfga:${this.openfgaVersion}`;
    this.chartVersion = config.chartVersion || OPENFGA_CHART_VERSION;
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

    if (this.dryRun) {
      // The rendered Helm chart is too verbose to be useful in the "Applied Configuration"
      // preview, and the real deploy call that always follows redoes this work anyway.
      this.log('OpenFGA installed successfully (dry run)', 'success');
      return;
    }

    await KubernetesHelper.ensureNamespace(this.namespace, this.spinner);
    await this.addHelmRepo();
    await this.installChart();
    await this.waitForOpenfga();

    await this.withPortForward(async baseUrl => {
      const storeId = await this.ensureStore(baseUrl);
      const modelId = await this.ensureAuthorizationModel(baseUrl, storeId);
      await this.writeSeedTuples(baseUrl, storeId, modelId);
      await this.writeBootstrapConfigMap(storeId, modelId);
    });

    this.log('OpenFGA installed successfully', 'success');
  }

  // ---------------------------------------------------------------------------
  // Helm chart install
  // ---------------------------------------------------------------------------

  async addHelmRepo() {
    this.log('Adding OpenFGA Helm repository...', 'info');
    await CommandRunner.run('helm', ['repo', 'add', 'openfga', OPENFGA_CHART_REPO], {
      ignoreError: true, // already added is fine
    });
    await CommandRunner.run('helm', ['repo', 'update']);
  }

  /** Split a full image ref (e.g. 'openfga/openfga:v1.22.1') into the chart's image.repository/tag values. */
  splitImageRef() {
    const lastColon = this.openfgaImage.lastIndexOf(':');
    if (lastColon === -1) return { repository: this.openfgaImage, tag: '' };
    return {
      repository: this.openfgaImage.slice(0, lastColon),
      tag: this.openfgaImage.slice(lastColon + 1),
    };
  }

  helmChartArgs() {
    const { repository, tag } = this.splitImageRef();
    return [
      'openfga',
      'openfga/openfga',
      '-n',
      this.namespace,
      '--version',
      this.chartVersion,
      '-f',
      join(CONFIG_DIR, 'values.yaml'),
      '--set',
      `image.repository=${repository}`,
      '--set',
      `image.tag=${tag}`,
    ];
  }

  async installChart() {
    this.log('Installing OpenFGA Helm chart...', 'info');
    await KubernetesHelper.helm([
      'upgrade',
      '-i',
      ...this.helmChartArgs(),
      '--create-namespace',
      '--wait',
      '--timeout',
      '3m',
    ]);
  }

  async waitForOpenfga() {
    this.log('Waiting for OpenFGA to be ready...', 'info');
    await KubernetesHelper.cleanupAndWaitForDeployment(
      this.namespace,
      'openfga',
      'app.kubernetes.io/name=openfga',
      180
    );
  }

  // ---------------------------------------------------------------------------
  // Bootstrap via OpenFGA HTTP API (port-forwarded - Service is ClusterIP-only)
  // ---------------------------------------------------------------------------

  async withPortForward(fn) {
    const localPort = PORT_FORWARD_LOCAL_PORT;
    const pfProc = spawn(
      'kubectl',
      [
        ...KubernetesHelper.contextArgs(),
        'port-forward',
        '-n',
        this.namespace,
        'svc/openfga',
        `${localPort}:${this.servicePort}`,
      ],
      { stdio: 'pipe' }
    );

    let stderrOutput = '';
    pfProc.stderr.on('data', data => {
      stderrOutput += data.toString();
    });

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
          const detail = stderrOutput.trim() || `exit code ${code}`;
          reject(new Error(`OpenFGA port-forward failed: ${detail}`));
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
    await KubernetesHelper.helm(['uninstall', 'openfga', '-n', this.namespace], {
      ignoreError: true, // release may not exist
    });
    await this.deleteResource('configmap', this.bootstrapConfigMapName);
    this.log('OpenFGA cleaned up', 'success');
  }
}

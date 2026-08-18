// addons/openfga/runbook.js
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const OPENFGA_VERSION = 'v1.10.3';

function _renderTemplate(template, vars) {
  return Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, v), template);
}

export function envVarsFor(_cfg) {
  return [];
}

export function envExportsFor(cfg) {
  const c = cfg || {};
  return [
    { key: 'OPENFGA_VERSION', value: c.version || OPENFGA_VERSION, group: 'versions' },
    { key: 'OPENFGA_NAMESPACE', value: c.namespace || 'openfga', group: 'settings' },
    { key: 'OPENFGA_STORE_NAME', value: c.storeName || 'agentgateway-demo', group: 'settings' },
  ];
}

export async function generate(_subIndex, profileAddonConfig) {
  const cfg = profileAddonConfig || {};
  const image = cfg.image || 'openfga/openfga:$OPENFGA_VERSION';

  const template = await readFile(join(__dirname, 'config', 'openfga.yaml'), 'utf8');
  const rendered = _renderTemplate(template, {
    NAMESPACE: '$OPENFGA_NAMESPACE',
    OPENFGA_IMAGE: image,
  });

  const lines = [];
  lines.push('### Install OpenFGA');
  lines.push('');
  lines.push(
    'Deploys OpenFGA (in-memory datastore) and bootstraps a store, authorization model, and seed relationship tuples via its HTTP API.'
  );
  lines.push('');
  lines.push('#### Create namespace');
  lines.push('');
  lines.push('```bash');
  lines.push(
    'kubectl create namespace ${OPENFGA_NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -'
  );
  lines.push('```');
  lines.push('');
  lines.push('#### Deploy OpenFGA');
  lines.push('');
  lines.push('```bash');
  lines.push('kubectl apply -f - <<EOF');
  lines.push(rendered.trimEnd());
  lines.push('EOF');
  lines.push('```');
  lines.push('');
  lines.push('#### Wait for OpenFGA to be ready');
  lines.push('');
  lines.push('```bash');
  lines.push('kubectl rollout status deployment/openfga -n ${OPENFGA_NAMESPACE} --timeout=180s');
  lines.push('```');
  lines.push('');
  lines.push('#### Bootstrap store, authorization model, and seed tuples');
  lines.push('');
  lines.push(
    'The Service is ClusterIP-only, so bootstrap runs over a port-forward. See addons/openfga/config/authorization-model.json for the model and addons/openfga/index.js (SEED_TUPLES) for the seed tuples.'
  );
  lines.push('');
  lines.push('```bash');
  lines.push('kubectl port-forward -n ${OPENFGA_NAMESPACE} svc/openfga 8080:8080 &');
  lines.push('PF_PID=$!');
  lines.push('sleep 2');
  lines.push('');
  lines.push('STORE_ID=$(curl -s -X POST http://localhost:8080/stores \\');
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push('  -d "{\\"name\\":\\"${OPENFGA_STORE_NAME}\\"}" | jq -r \'.id\')');
  lines.push('');
  lines.push(
    'MODEL_ID=$(curl -s -X POST http://localhost:8080/stores/${STORE_ID}/authorization-models \\'
  );
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push(
    "  -d @addons/openfga/config/authorization-model.json | jq -r '.authorization_model_id')"
  );
  lines.push('');
  lines.push('# Seed relationship tuples (writes.tuple_keys, on_duplicate: ignore) - see');
  lines.push('# addons/openfga/index.js SEED_TUPLES for the full list');
  lines.push('curl -s -X POST http://localhost:8080/stores/${STORE_ID}/write \\');
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push(
    '  -d "{\\"writes\\":{\\"tuple_keys\\":[...],\\"on_duplicate\\":\\"ignore\\"},\\"authorization_model_id\\":\\"${MODEL_ID}\\"}"'
  );
  lines.push('');
  lines.push('kubectl create configmap openfga-bootstrap -n ${OPENFGA_NAMESPACE} \\');
  lines.push('  --from-literal=storeId=${STORE_ID} \\');
  lines.push('  --from-literal=modelId=${MODEL_ID} \\');
  lines.push('  --dry-run=client -o yaml | kubectl apply -f -');
  lines.push('');
  lines.push('kill $PF_PID');
  lines.push('```');

  return lines.join('\n');
}

export function cleanup(_cfg) {
  return [
    '```bash',
    'kubectl delete all --all -n ${OPENFGA_NAMESPACE}',
    'kubectl delete namespace ${OPENFGA_NAMESPACE} --ignore-not-found',
    '```',
  ].join('\n');
}

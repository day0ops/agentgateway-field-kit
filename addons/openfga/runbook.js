// addons/openfga/runbook.js

const OPENFGA_VERSION = 'v1.22.1';
const OPENFGA_CHART_VERSION = '0.4.1';

export function envVarsFor(_cfg) {
  return [];
}

export function envExportsFor(cfg) {
  const c = cfg || {};
  return [
    { key: 'OPENFGA_VERSION', value: c.version || OPENFGA_VERSION, group: 'versions' },
    {
      key: 'OPENFGA_CHART_VERSION',
      value: c.chartVersion || OPENFGA_CHART_VERSION,
      group: 'versions',
    },
    { key: 'OPENFGA_NAMESPACE', value: c.namespace || 'openfga', group: 'settings' },
    { key: 'OPENFGA_STORE_NAME', value: c.storeName || 'agentgateway-demo', group: 'settings' },
  ];
}

export async function generate(_subIndex, profileAddonConfig) {
  const cfg = profileAddonConfig || {};
  const image = cfg.image || 'openfga/openfga:${OPENFGA_VERSION}';
  const lastColon = image.lastIndexOf(':');
  const imageRepository = lastColon === -1 ? image : image.slice(0, lastColon);
  const imageTag = lastColon === -1 ? '' : image.slice(lastColon + 1);

  const lines = [];
  lines.push('### Install OpenFGA');
  lines.push('');
  lines.push(
    'Deploys OpenFGA (in-memory datastore) via its official Helm chart, then bootstraps a store, authorization model, and seed relationship tuples via its HTTP API.'
  );
  lines.push('');
  lines.push('#### Install OpenFGA via Helm');
  lines.push('');
  lines.push('```bash');
  lines.push('helm repo add openfga https://openfga.github.io/helm-charts');
  lines.push('helm repo update');
  lines.push('');
  lines.push('helm upgrade -i openfga openfga/openfga \\');
  lines.push('  -n ${OPENFGA_NAMESPACE} \\');
  lines.push('  --version ${OPENFGA_CHART_VERSION} \\');
  lines.push('  -f addons/openfga/config/values.yaml \\');
  lines.push(`  --set image.repository=${imageRepository} \\`);
  lines.push(`  --set image.tag=${imageTag} \\`);
  lines.push('  --create-namespace \\');
  lines.push('  --wait --timeout 3m');
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
  lines.push('  --from-literal=storeName=${OPENFGA_STORE_NAME} \\');
  lines.push('  --dry-run=client -o yaml | kubectl apply -f -');
  lines.push('');
  lines.push('kill $PF_PID');
  lines.push('```');

  return lines.join('\n');
}

export function cleanup(_cfg) {
  return [
    '```bash',
    'helm uninstall openfga -n ${OPENFGA_NAMESPACE}',
    'kubectl delete namespace ${OPENFGA_NAMESPACE} --ignore-not-found',
    '```',
  ].join('\n');
}

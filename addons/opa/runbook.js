// addons/opa/runbook.js
const DEFAULT_OPA_IMAGE =
  'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/opa-ext-authz:latest';

export function envVarsFor(_cfg) {
  return [];
}

export function envExportsFor(cfg) {
  const c = cfg || {};
  return [{ key: 'OPA_NAMESPACE', value: c.namespace || 'opa', group: 'settings' }];
}

export async function generate(_subIndex, profileAddonConfig) {
  const cfg = profileAddonConfig || {};
  const image = cfg.image || DEFAULT_OPA_IMAGE;

  const lines = [];
  lines.push('### Install OPA');
  lines.push('');
  lines.push(
    "Deploys the custom OPA image (github.com/day0ops/opa-ext-authz) - OPA's official envoy_ext_authz_grpc-enabled build with Rego authorization policies baked in. No bootstrap step needed - unlike OpenFGA, there is nothing to seed at deploy time."
  );
  lines.push('');
  lines.push('#### Create namespace');
  lines.push('');
  lines.push('```bash');
  lines.push(
    'kubectl create namespace ${OPA_NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -'
  );
  lines.push('```');
  lines.push('');
  lines.push('#### Deploy OPA');
  lines.push('');
  lines.push('```bash');
  lines.push('kubectl apply -f - <<EOF');
  lines.push('apiVersion: apps/v1');
  lines.push('kind: Deployment');
  lines.push('metadata:');
  lines.push('  name: opa');
  lines.push('  namespace: ${OPA_NAMESPACE}');
  lines.push('  labels: { app: opa }');
  lines.push('spec:');
  lines.push('  replicas: 1');
  lines.push('  selector: { matchLabels: { app: opa } }');
  lines.push('  template:');
  lines.push('    metadata: { labels: { app: opa } }');
  lines.push('    spec:');
  lines.push('      containers:');
  lines.push('        - name: opa');
  lines.push(`          image: ${image}`);
  lines.push('          ports:');
  lines.push('            - { name: http, containerPort: 8181 }');
  lines.push('            - { name: grpc, containerPort: 9191 }');
  lines.push('---');
  lines.push('apiVersion: v1');
  lines.push('kind: Service');
  lines.push('metadata:');
  lines.push('  name: opa');
  lines.push('  namespace: ${OPA_NAMESPACE}');
  lines.push('  labels: { app: opa }');
  lines.push('spec:');
  lines.push('  selector: { app: opa }');
  lines.push('  ports:');
  lines.push('    - { name: http, port: 8181, targetPort: 8181 }');
  lines.push('    - { name: grpc, port: 9191, targetPort: 9191 }');
  lines.push('EOF');
  lines.push('```');
  lines.push('');
  lines.push('#### Wait for OPA to be ready');
  lines.push('');
  lines.push('```bash');
  lines.push('kubectl rollout status deployment/opa -n ${OPA_NAMESPACE} --timeout=120s');
  lines.push('```');

  return lines.join('\n');
}

export function cleanup(_cfg) {
  return [
    '```bash',
    'kubectl delete all --all -n ${OPA_NAMESPACE}',
    'kubectl delete namespace ${OPA_NAMESPACE} --ignore-not-found',
    '```',
  ].join('\n');
}

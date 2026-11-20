// addons/pingfederate/runbook.js

const DEFAULT_PF_VERSION_TAG = '2610'; // PingFederate 13.1.4
const ADMIN_PORT = 9999;

export function envVarsFor(_cfg) {
  return ['PING_IDENTITY_DEVOPS_USER', 'PING_IDENTITY_DEVOPS_KEY'];
}

export function envExportsFor(cfg) {
  const c = cfg || {};
  return [
    { key: 'PF_VERSION_TAG', value: c.versionTag || DEFAULT_PF_VERSION_TAG, group: 'versions' },
    { key: 'PF_NAMESPACE', value: c.namespace || 'pingfederate', group: 'settings' },
  ];
}

export async function generate(_subIndex, profileAddonConfig) {
  const cfg = profileAddonConfig || {};
  const issuer = cfg.issuer || '';

  const lines = [];
  lines.push('### Install PingFederate');
  lines.push('');
  lines.push(
    "Deploys PingFederate (admin + engine, Ping Identity's official ping-devops Helm chart) licensed via the DevOps Program's evaluation license, then bootstraps the Authorization Code grant type, a JSON Web Tokens Access Token Manager, and a public/PKCE OAuth client via the Admin REST API."
  );
  lines.push('');
  lines.push('#### Create the DevOps Program license secret');
  lines.push('');
  lines.push('```bash');
  lines.push('kubectl create secret generic devops-secret -n ${PF_NAMESPACE} \\');
  lines.push('  --from-literal=PING_IDENTITY_DEVOPS_USER=${PING_IDENTITY_DEVOPS_USER} \\');
  lines.push('  --from-literal=PING_IDENTITY_DEVOPS_KEY=${PING_IDENTITY_DEVOPS_KEY} \\');
  lines.push('  --from-literal=PING_IDENTITY_ACCEPT_EULA=YES \\');
  lines.push('  --dry-run=client -o yaml | kubectl apply -f -');
  lines.push('```');
  lines.push('');
  lines.push('#### Install PingFederate via Helm');
  lines.push('');
  lines.push('```bash');
  lines.push('helm repo add pingidentity https://helm.pingidentity.com/');
  lines.push('helm repo update');
  lines.push('');
  lines.push('helm upgrade -i pingfederate pingidentity/ping-devops \\');
  lines.push('  -n ${PF_NAMESPACE} \\');
  lines.push('  --set pingfederate-admin.enabled=true \\');
  lines.push('  --set pingfederate-engine.enabled=true \\');
  lines.push('  --set pingfederate-admin.image.tag=${PF_VERSION_TAG} \\');
  lines.push('  --set pingfederate-engine.image.tag=${PF_VERSION_TAG} \\');
  lines.push('  --set global.license.secret.devOps=devops-secret \\');
  lines.push('  --create-namespace --wait --timeout 10m');
  lines.push('```');
  lines.push('');
  lines.push('#### Wait for the admin node to be ready');
  lines.push('');
  lines.push('```bash');
  lines.push(
    'kubectl rollout status deployment/pingfederate-pingfederate-admin -n ${PF_NAMESPACE} --timeout=600s'
  );
  lines.push('```');
  lines.push('');
  lines.push('#### Bootstrap license agreement, Access Token Manager, and OAuth Client');
  lines.push('');
  lines.push(
    'No persistent storage backs this deployment, so every Admin-API-driven setting here is wiped on any pod restart - this bootstrap re-applies in full on every deploy rather than once. The admin Service is ClusterIP-only, so it runs over a port-forward. See addons/pingfederate/index.js for the full Admin API logic (the Access Token Manager uses a live plugin-descriptor lookup rather than a hardcoded payload, since ATM configuration is plugin-defined, and uses the centralized signing key rather than a per-ATM certificate - the latter certificate-selection field never accepted a newly generated key in testing).'
  );
  lines.push('');
  lines.push('```bash');
  lines.push(
    `kubectl port-forward -n \${PF_NAMESPACE} svc/pingfederate-pingfederate-admin ${ADMIN_PORT}:${ADMIN_PORT} &`
  );
  lines.push('PF_PID=$!');
  lines.push('sleep 2');
  lines.push('');
  lines.push(
    `curl -sk -u Administrator:\${PING_IDENTITY_PASSWORD:-2FederateM0re} -H "X-XSRF-Header: PingFederate" -X PUT -d '{"accepted":true}' https://localhost:${ADMIN_PORT}/pf-admin-api/v1/license/agreement`
  );
  lines.push('# ... POST /oauth/accessTokenManagers using the JSON Web Tokens plugin descriptor,');
  lines.push('#     Use Centralized Signing Key=true, JWS Algorithm=RS256');
  if (issuer) {
    lines.push(`#     (issuer, for agentgateway's own config, not PingFederate's: ${issuer})`);
  }
  lines.push(
    '# ... POST /oauth/clients (public/PKCE via requireProofKeyForCodeExchange, redirect_uri http://localhost:8766/callback)'
  );
  lines.push('');
  lines.push('kill $PF_PID');
  lines.push('```');

  return lines.join('\n');
}

export function cleanup(_cfg) {
  return [
    '```bash',
    'helm uninstall pingfederate -n ${PF_NAMESPACE}',
    'kubectl delete namespace ${PF_NAMESPACE} --ignore-not-found',
    '```',
  ].join('\n');
}

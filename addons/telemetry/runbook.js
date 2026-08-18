// addons/telemetry/runbook.js

export function envVarsFor(_cfg) {
  return [
    { name: 'GRAFANA_ADMIN_USERNAME', required: true, description: 'Grafana admin login username' },
    { name: 'GRAFANA_ADMIN_PASSWORD', required: true, description: 'Grafana admin login password' },
  ];
}

export function envExportsFor(_cfg) {
  return [
    { key: 'PROMETHEUS_STACK_VERSION', value: '80.4.2', group: 'versions' },
    { key: 'TEMPO_VERSION', value: '1.29.0', group: 'versions' },
    { key: 'LOKI_VERSION', value: '6.6.2', group: 'versions' },
    { key: 'ALLOY_VERSION', value: '0.12.0', group: 'versions' },
    { key: 'TELEMETRY_NAMESPACE', value: 'telemetry', group: 'settings' },
  ];
}

export async function generate(_subIndex, _cfg) {
  const lines = [];
  lines.push('### Install Telemetry Stack');
  lines.push('');
  lines.push(
    'Installs Prometheus/Grafana, Tempo Distributed, Loki, and Alloy for full observability.'
  );
  lines.push('');
  lines.push('#### Add Helm repositories');
  lines.push('');
  lines.push('```bash');
  lines.push(
    'helm repo add prometheus-community https://prometheus-community.github.io/helm-charts'
  );
  lines.push('helm repo add grafana https://grafana.github.io/helm-charts');
  lines.push('helm repo update');
  lines.push('```');
  lines.push('');
  lines.push('#### Install kube-prometheus-stack');
  lines.push('');
  lines.push('```bash');
  lines.push('helm upgrade -i kube-prometheus-stack prometheus-community/kube-prometheus-stack \\');
  lines.push('  -n ${TELEMETRY_NAMESPACE} \\');
  lines.push('  --version ${PROMETHEUS_STACK_VERSION} \\');
  lines.push('  --set-string grafana.adminUser=${GRAFANA_ADMIN_USERNAME} \\');
  lines.push('  --set-string grafana.adminPassword=${GRAFANA_ADMIN_PASSWORD} \\');
  lines.push('  --create-namespace \\');
  lines.push('  --wait');
  lines.push('```');
  lines.push('');
  lines.push('#### Install tempo-distributed');
  lines.push('');
  lines.push('```bash');
  lines.push('helm upgrade -i tempo grafana/tempo-distributed \\');
  lines.push('  -n ${TELEMETRY_NAMESPACE} \\');
  lines.push('  --version ${TEMPO_VERSION} \\');
  lines.push('  --create-namespace \\');
  lines.push('  --wait');
  lines.push('```');
  lines.push('');
  lines.push('#### Install loki');
  lines.push('');
  lines.push('```bash');
  lines.push('helm upgrade -i loki grafana/loki \\');
  lines.push('  -n ${TELEMETRY_NAMESPACE} \\');
  lines.push('  --version ${LOKI_VERSION} \\');
  lines.push('  --create-namespace \\');
  lines.push('  --wait');
  lines.push('```');
  lines.push('');
  lines.push('#### Install alloy');
  lines.push('');
  lines.push('```bash');
  lines.push('helm upgrade -i alloy grafana/alloy \\');
  lines.push('  -n ${TELEMETRY_NAMESPACE} \\');
  lines.push('  --version ${ALLOY_VERSION} \\');
  lines.push('  --create-namespace \\');
  lines.push('  --wait');
  lines.push('```');
  return lines.join('\n');
}

export function cleanup(_cfg) {
  return [
    '```bash',
    'helm uninstall alloy -n ${TELEMETRY_NAMESPACE}',
    'helm uninstall loki -n ${TELEMETRY_NAMESPACE}',
    'helm uninstall tempo -n ${TELEMETRY_NAMESPACE}',
    'helm uninstall kube-prometheus-stack -n ${TELEMETRY_NAMESPACE}',
    'kubectl delete namespace ${TELEMETRY_NAMESPACE} --ignore-not-found',
    '```',
  ].join('\n');
}

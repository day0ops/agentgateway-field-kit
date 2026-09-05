// addons/keycloak/runbook.js
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const KEYCLOAK_VERSION = '26.6.2';
const POSTGRES_VERSION = '18.2-alpine';

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v) ? v : fb);

function _renderTemplate(template, vars) {
  return Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, v), template);
}

function _generateStandardRealmCurls(realm) {
  const lines = [];
  const realmName = realm.realm;
  const isGrafanaRealm = realmName === 'grafana';
  lines.push(`# Create realm: ${realmName}`);
  lines.push(`curl -sk -X POST "\${KEYCLOAK_SCHEME}://\${KEYCLOAK_HOST}/admin/realms" \\`);
  lines.push(`  -H "Authorization: Bearer $KEYCLOAK_TOKEN" \\`);
  lines.push(`  -H "Content-Type: application/json" \\`);
  lines.push(`  -d '{"realm":"${realmName}","enabled":true,"loginWithEmailAllowed":true}'`);

  for (const client of realm.clients || []) {
    const isPublic = client.type === 'public';
    const flows = client.flows || [];
    const serviceAccountsEnabled = !isPublic && flows.includes('service-account');
    const standardFlowEnabled = flows.includes('authorization-code');
    lines.push('');
    lines.push(`# Client: ${client.clientId} (${client.type})`);
    lines.push(
      `curl -sk -X POST "\${KEYCLOAK_SCHEME}://\${KEYCLOAK_HOST}/admin/realms/${realmName}/clients" \\`
    );
    lines.push(`  -H "Authorization: Bearer $KEYCLOAK_TOKEN" \\`);
    lines.push(`  -H "Content-Type: application/json" \\`);
    const clientPayload = {
      clientId: client.clientId,
      publicClient: isPublic,
      serviceAccountsEnabled,
      standardFlowEnabled,
    };
    if (!isPublic && client.clientSecret) {
      clientPayload.secret = client.clientSecret;
    }
    lines.push(`  -d '${JSON.stringify(clientPayload)}'`);
  }

  for (const user of realm.users || []) {
    const attrs = {};
    for (const [k, v] of Object.entries(user.attributes || {})) {
      attrs[k] = [v];
    }
    lines.push('');
    lines.push(`# User: ${isGrafanaRealm ? '$GRAFANA_REALM_ADMIN_USERNAME' : user.username}`);
    lines.push(
      `curl -sk -X POST "\${KEYCLOAK_SCHEME}://\${KEYCLOAK_HOST}/admin/realms/${realmName}/users" \\`
    );
    lines.push(`  -H "Authorization: Bearer $KEYCLOAK_TOKEN" \\`);
    lines.push(`  -H "Content-Type: application/json" \\`);
    if (isGrafanaRealm) {
      // Credentials render as shell variable references (with a bash default-value
      // expansion for the username) so they're read from the operator's environment
      // instead of being baked into this generated doc.
      lines.push(
        `  -d '{"username":"'"\${GRAFANA_REALM_ADMIN_USERNAME:-grafana-admin}"'","email":"${user.email || ''}","firstName":"${user.firstName || ''}","lastName":"${user.lastName || ''}","enabled":true,"credentials":[{"type":"password","value":"'"$GRAFANA_REALM_ADMIN_PASSWORD"'","temporary":false}],"attributes":${JSON.stringify(attrs)}}'`
      );
    } else {
      const userPayload = {
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        enabled: true,
        credentials: [
          { type: 'password', value: realm.defaultPassword || 'Password1!', temporary: false },
        ],
        attributes: attrs,
      };
      lines.push(`  -d '${JSON.stringify(userPayload)}'`);
    }
  }

  return lines.join('\n');
}

function _generateOrgRealmCurls(realm) {
  const lines = [];
  const realmName = realm.realm;
  lines.push(`# Create realm: ${realmName}`);
  lines.push(`curl -sk -X POST "\${KEYCLOAK_SCHEME}://\${KEYCLOAK_HOST}/admin/realms" \\`);
  lines.push(`  -H "Authorization: Bearer $KEYCLOAK_TOKEN" \\`);
  lines.push(`  -H "Content-Type: application/json" \\`);
  lines.push(`  -d '{"realm":"${realmName}","enabled":true}'`);

  for (const team of realm.teams || []) {
    lines.push('');
    lines.push(`# Team client: ${team.clientId}`);
    lines.push(
      `curl -sk -X POST "\${KEYCLOAK_SCHEME}://\${KEYCLOAK_HOST}/admin/realms/${realmName}/clients" \\`
    );
    lines.push(`  -H "Authorization: Bearer $KEYCLOAK_TOKEN" \\`);
    lines.push(`  -H "Content-Type: application/json" \\`);
    const teamClientPayload = {
      clientId: team.clientId,
      secret: team.clientSecret,
      publicClient: false,
      serviceAccountsEnabled: true,
    };
    lines.push(`  -d '${JSON.stringify(teamClientPayload)}'`);

    for (const user of team.users || []) {
      const attrs = {};
      for (const [k, v] of Object.entries(user.attributes || {})) {
        attrs[k] = [v];
      }
      const userPayload = {
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        enabled: true,
        credentials: [
          { type: 'password', value: realm.defaultPassword || 'Password1!', temporary: false },
        ],
        attributes: attrs,
      };
      lines.push('');
      lines.push(`# User: ${user.username}`);
      lines.push(
        `curl -sk -X POST "\${KEYCLOAK_SCHEME}://\${KEYCLOAK_HOST}/admin/realms/${realmName}/users" \\`
      );
      lines.push(`  -H "Authorization: Bearer $KEYCLOAK_TOKEN" \\`);
      lines.push(`  -H "Content-Type: application/json" \\`);
      lines.push(`  -d '${JSON.stringify(userPayload)}'`);
    }
  }
  return lines.join('\n');
}

export function envVarsFor(cfg) {
  const vars = [
    {
      name: 'KEYCLOAK_ADMIN_USERNAME',
      required: true,
      description: 'Keycloak master realm bootstrap admin username',
    },
    {
      name: 'KEYCLOAK_ADMIN_PASSWORD',
      required: true,
      description: 'Keycloak master realm bootstrap admin password',
    },
    {
      name: 'KEYCLOAK_POSTGRES_USER',
      required: true,
      description: "Postgres superuser backing Keycloak's DB",
    },
    {
      name: 'KEYCLOAK_POSTGRES_PASSWORD',
      required: true,
      description: 'Postgres superuser password',
    },
  ];
  if (cfg?.soloUiClients?.enabled) {
    vars.push({
      name: 'SOLO_UI_DEFAULT_PASSWORD',
      required: true,
      description: 'Solo UI demo bootstrap password (solo-admin/solo-reader/solo-writer)',
    });
  }
  if ((cfg?.realms || []).some(r => r.realm === 'grafana')) {
    vars.push(
      {
        name: 'GRAFANA_REALM_ADMIN_USERNAME',
        required: false,
        description: "Grafana OIDC demo admin username (default: 'grafana-admin')",
      },
      {
        name: 'GRAFANA_REALM_ADMIN_PASSWORD',
        required: true,
        description: 'Grafana OIDC demo admin password',
      }
    );
  }
  return vars;
}

export function envExportsFor(cfg) {
  const c = cfg || {};
  return [
    { key: 'KEYCLOAK_VERSION', value: c.keycloakVersion || KEYCLOAK_VERSION, group: 'versions' },
    { key: 'POSTGRES_VERSION', value: c.postgresVersion || POSTGRES_VERSION, group: 'versions' },
    { key: 'KC_NAMESPACE', value: c.keycloakNamespace || 'keycloak', group: 'settings' },
    { key: 'KEYCLOAK_HOST', value: c.hostname || '<KEYCLOAK_HOST>', group: 'endpoints' },
    { key: 'KEYCLOAK_SCHEME', value: c.protocol || 'https', group: 'endpoints' },
  ];
}

export async function generate(_subIndex, profileAddonConfig) {
  const cfg = profileAddonConfig || {};
  const tlsSecretName = cfg.tls?.secretName || 'keycloak-tls';
  const storageClass = cfg.postgres?.persistentVolume?.storageClass || '';
  const postgresPvcSize = cfg.postgres?.persistentVolume?.size || '5Gi';

  const postgresTemplate = await readFile(join(__dirname, 'config', 'postgres.yaml'), 'utf8');
  const keycloakTemplate = await readFile(join(__dirname, 'config', 'keycloak.yaml'), 'utf8');

  let postgresRendered = _renderTemplate(postgresTemplate, {
    NAMESPACE: '$KC_NAMESPACE',
    POSTGRES_VERSION: '$POSTGRES_VERSION',
    STORAGE_CLASS_NAME: storageClass,
    POSTGRES_PVC_SIZE: postgresPvcSize,
    POSTGRES_USER: '$KEYCLOAK_POSTGRES_USER',
    POSTGRES_PASSWORD: '$KEYCLOAK_POSTGRES_PASSWORD',
  });
  postgresRendered = postgresRendered.replace(/\n\s*storageClassName: ''\n/, '\n');

  // cfg.keycloakImage may be a bare repo (append $KEYCLOAK_VERSION) or already a full
  // repo:tag reference - mirrors the same detection in addons/keycloak/index.js.
  const keycloakImageBase = cfg.keycloakImage || 'quay.io/keycloak/keycloak';
  const keycloakImageHasTag = /:[^/]+$/.test(cfg.keycloakImage || '');
  const keycloakRendered = _renderTemplate(keycloakTemplate, {
    NAMESPACE: '$KC_NAMESPACE',
    HOSTNAME: '$KEYCLOAK_HOST',
    KEYCLOAK_IMAGE: keycloakImageHasTag
      ? keycloakImageBase
      : `${keycloakImageBase}:$KEYCLOAK_VERSION`,
    TLS_SECRET_NAME: tlsSecretName,
    ADMIN_USERNAME: '$KEYCLOAK_ADMIN_USERNAME',
    ADMIN_PASSWORD: '$KEYCLOAK_ADMIN_PASSWORD',
  });

  // sourceRanges mixes a real env value ({{env.security.vpnSourceRanges}}) with a
  // per-cluster infra-state token (the NAT gateway IP) neither of which this generator
  // can resolve (no env/infraState passed in here) — each falls back to a readable
  // placeholder instead of leaving `{{...}}` literally in the runbook.
  const sourceRangesList = Array.isArray(cfg.sourceRanges) ? cfg.sourceRanges : [cfg.sourceRanges];
  const sourceRanges = sourceRangesList
    .filter(Boolean)
    .map(r => {
      if (r === '{{env.security.vpnSourceRanges}}') return '<vpn-cidr>';
      const infraMatch = r?.match?.(/infra\.clusters\.(\w+)\.network\.natGatewayIp/);
      if (infraMatch) return `<${infraMatch[1]}-nat-gateway-ip>/32`;
      return tpl(r, r);
    })
    .join(',');

  const lines = [];
  lines.push('### Install Keycloak');
  lines.push('');
  lines.push('Deploys Keycloak identity provider with PostgreSQL backend.');
  lines.push('');
  lines.push('#### Create namespace');
  lines.push('');
  lines.push('```bash');
  lines.push(
    'kubectl create namespace ${KC_NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -'
  );
  lines.push('```');
  lines.push('');
  lines.push('#### Deploy PostgreSQL');
  lines.push('');
  lines.push('```bash');
  lines.push('kubectl apply -f - <<EOF');
  lines.push(postgresRendered.trimEnd());
  lines.push('EOF');
  lines.push('```');
  lines.push('');
  lines.push('#### Wait for PostgreSQL to be ready');
  lines.push('');
  lines.push('```bash');
  lines.push('kubectl rollout status deployment/postgres -n ${KC_NAMESPACE} --timeout=120s');
  lines.push('```');
  lines.push('');
  lines.push('#### Deploy Keycloak');
  lines.push('');
  lines.push('```bash');
  lines.push('kubectl apply -f - <<EOF');
  lines.push(keycloakRendered.trimEnd());
  lines.push('EOF');
  lines.push('```');
  if (sourceRanges) {
    lines.push('');
    lines.push('#### Gate the NLB to an allowed CIDR list');
    lines.push('');
    lines.push(
      '(the AWS Load Balancer Controller reads this annotation and rewrites its managed security group; `nlb-target-type=ip` requires client-IP preservation to be re-enabled or the CIDR gate is silently ignored)'
    );
    lines.push('');
    lines.push('```bash');
    lines.push('kubectl annotate service keycloak -n ${KC_NAMESPACE} \\');
    lines.push('  "service.beta.kubernetes.io/aws-load-balancer-type=external" \\');
    lines.push('  "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type=ip" \\');
    lines.push('  "service.beta.kubernetes.io/aws-load-balancer-scheme=internet-facing" \\');
    lines.push(
      '  "service.beta.kubernetes.io/aws-load-balancer-target-group-attributes=preserve_client_ip.enabled=true" \\'
    );
    lines.push(`  "service.beta.kubernetes.io/load-balancer-source-ranges=${sourceRanges}" \\`);
    lines.push('  --overwrite');
    lines.push('```');
  }
  lines.push('');
  lines.push('#### Wait for Keycloak to be ready');
  lines.push('');
  lines.push('```bash');
  lines.push('kubectl rollout status deployment/keycloak -n ${KC_NAMESPACE} --timeout=600s');
  lines.push('```');
  lines.push('');
  lines.push('#### Configure Keycloak via Admin API');
  lines.push('');
  lines.push('```bash');
  lines.push('# Get admin token');
  lines.push('KEYCLOAK_TOKEN=$(curl -sk -X POST \\');
  lines.push(
    '  "${KEYCLOAK_SCHEME}://${KEYCLOAK_HOST}/realms/master/protocol/openid-connect/token" \\'
  );
  lines.push(
    '  -d "client_id=admin-cli&grant_type=password&username=${KEYCLOAK_ADMIN_USERNAME}&password=${KEYCLOAK_ADMIN_PASSWORD}" | jq -r \'.access_token\')'
  );

  const realms = cfg.realms || [];
  for (const realm of realms) {
    lines.push('');
    if (realm.teams) {
      lines.push(_generateOrgRealmCurls(realm));
    } else {
      lines.push(_generateStandardRealmCurls(realm));
    }
  }

  const workloadClients = cfg.workloadClients || [];
  if (workloadClients.length > 0) {
    lines.push('');
    lines.push('# Create workload client Kubernetes secrets');
    for (const wc of workloadClients) {
      lines.push('');
      lines.push(`kubectl create secret generic ${wc.k8sSecretName} \\`);
      lines.push(`  -n \${AGW_NAMESPACE} \\`);
      lines.push(`  --from-literal=clientId=${wc.clientId} \\`);
      lines.push(`  --from-literal=clientSecret=${wc.clientSecret} \\`);
      lines.push(`  --from-literal=audience=${wc.audience} \\`);
      lines.push('  --dry-run=client -o yaml | kubectl apply -f -');
    }
  }

  const soloUiClients = cfg.soloUiClients;
  if (soloUiClients?.enabled) {
    const suiRealm = soloUiClients.realm || 'solo-ui';
    lines.push('');
    lines.push(`# Create Solo UI realm: ${suiRealm}`);
    lines.push(`curl -sk -X POST "\${KEYCLOAK_SCHEME}://\${KEYCLOAK_HOST}/admin/realms" \\`);
    lines.push(`  -H "Authorization: Bearer $KEYCLOAK_TOKEN" \\`);
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -d '{"realm":"${suiRealm}","enabled":true}'`);

    if (soloUiClients.backendClientId) {
      const backendPayload = {
        clientId: soloUiClients.backendClientId,
        secret: soloUiClients.backendClientSecret,
        publicClient: false,
        serviceAccountsEnabled: false,
        standardFlowEnabled: true,
      };
      lines.push('');
      lines.push(`# Backend client (confidential): ${soloUiClients.backendClientId}`);
      lines.push(
        `curl -sk -X POST "\${KEYCLOAK_SCHEME}://\${KEYCLOAK_HOST}/admin/realms/${suiRealm}/clients" \\`
      );
      lines.push(`  -H "Authorization: Bearer $KEYCLOAK_TOKEN" \\`);
      lines.push(`  -H "Content-Type: application/json" \\`);
      lines.push(`  -d '${JSON.stringify(backendPayload)}'`);
    }

    if (soloUiClients.frontendClientId) {
      const frontendPayload = {
        clientId: soloUiClients.frontendClientId,
        publicClient: true,
        serviceAccountsEnabled: false,
        standardFlowEnabled: true,
      };
      lines.push('');
      lines.push(`# Frontend client (public): ${soloUiClients.frontendClientId}`);
      lines.push(
        `curl -sk -X POST "\${KEYCLOAK_SCHEME}://\${KEYCLOAK_HOST}/admin/realms/${suiRealm}/clients" \\`
      );
      lines.push(`  -H "Authorization: Bearer $KEYCLOAK_TOKEN" \\`);
      lines.push(`  -H "Content-Type: application/json" \\`);
      lines.push(`  -d '${JSON.stringify(frontendPayload)}'`);
    }
  }

  lines.push('```');
  return lines.join('\n');
}

export function cleanup(_cfg) {
  return [
    '```bash',
    'kubectl delete all --all -n ${KC_NAMESPACE}',
    'kubectl delete namespace ${KC_NAMESPACE} --ignore-not-found',
    '```',
  ].join('\n');
}

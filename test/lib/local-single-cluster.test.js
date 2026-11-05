import { test, expect, describe } from 'bun:test';
import { ProfileManager } from '../../src/lib/profiles.js';

const PROFILE_PATH = `${ProfileManager.PROFILES_DIR}/local-single-cluster-with-solo-ui.yaml`;

describe('local-single-cluster-with-solo-ui profile', () => {
  test('has no infra field (BYO)', async () => {
    const profile = await ProfileManager.load(PROFILE_PATH);
    expect(profile.infra).toBeNull();
  });

  test('resolves cert-manager and external-dns against the cloudflare zone', async () => {
    const profile = await ProfileManager.load(PROFILE_PATH);
    const certManager = profile.addons.find(a => a.name === 'cert-manager');
    const externalDns = profile.addons.find(a => a.name === 'external-dns');
    expect(certManager.config.letsencrypt.provider).toBe('cloudflare');
    expect(externalDns.config.domainFilter).toBe('day0ops.com');
  });

  test('keycloak provisions both the agw-dev realm (demo-wizard OAuth clients) and solo-ui', async () => {
    const profile = await ProfileManager.load(PROFILE_PATH);
    const keycloak = profile.addons.find(a => a.name === 'keycloak');
    expect(keycloak.config.workloadClients).toBeUndefined();
    expect(keycloak.config.soloUiClients.enabled).toBe(true);

    const agwDev = keycloak.config.realms.find(r => r.realm === 'agw-dev');
    expect(agwDev).toBeDefined();
    const clientIds = agwDev.clients.map(c => c.clientId);
    expect(clientIds).toEqual([
      'agw-client',
      'agw-client-public',
      'agw-issuer',
      'quota-management',
      'agw-token-exchange',
      'agw-ext-auth',
    ]);
    const usernames = agwDev.users.map(u => u.username);
    expect(usernames).toEqual([
      'acme-corp-admin',
      'user1',
      'user2',
      'team-alpha-admin',
      'team-beta-admin',
    ]);
  });

  test('ui is OIDC-protected against the real keycloak hostname, configured at the top level', async () => {
    const profile = await ProfileManager.load(PROFILE_PATH);
    expect(profile.addons.find(a => a.name === 'solo-ui')).toBeUndefined();
    expect(profile.ui.enabled).toBe(true);
    expect(profile.ui.oidc.enabled).toBe(true);
    expect(profile.ui.oidc.issuerUrl).toBe('https://keycloak.agw.lab.day0ops.com/realms/solo-ui');
    expect(profile.ui.oidc.backendClientSecret).toBe('solo-ui-backend-secret');
  });

  test('telemetry exposes a real grafana hostname', async () => {
    const profile = await ProfileManager.load(PROFILE_PATH);
    const telemetry = profile.addons.find(a => a.name === 'telemetry');
    expect(telemetry.config.grafanaHostname).toBe('grafana.agw.lab.day0ops.com');
  });

  test('keycloak protocol and loginTheme resolve from the environment', async () => {
    const profile = await ProfileManager.load(PROFILE_PATH);
    const keycloak = profile.addons.find(a => a.name === 'keycloak');
    expect(keycloak.config.protocol).toBe('https');
    expect(keycloak.config.loginTheme).toBe('keycloak-soloio-login-theme');
  });
});

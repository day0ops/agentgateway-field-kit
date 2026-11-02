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

  test('keycloak only provisions the solo-ui realm, not agw-dev', async () => {
    const profile = await ProfileManager.load(PROFILE_PATH);
    const keycloak = profile.addons.find(a => a.name === 'keycloak');
    expect(keycloak.config.realms).toBeUndefined();
    expect(keycloak.config.soloUiClients.enabled).toBe(true);
  });

  test('solo-ui is OIDC-protected against the real keycloak hostname', async () => {
    const profile = await ProfileManager.load(PROFILE_PATH);
    const soloUi = profile.addons.find(a => a.name === 'solo-ui');
    expect(soloUi.config.oidc.enabled).toBe(true);
    expect(soloUi.config.oidc.issuerUrl).toBe(
      'https://keycloak.agw.lab.day0ops.com/realms/solo-ui'
    );
  });

  test('telemetry exposes a real grafana hostname', async () => {
    const profile = await ProfileManager.load(PROFILE_PATH);
    const telemetry = profile.addons.find(a => a.name === 'telemetry');
    expect(telemetry.config.grafanaHostname).toBe('grafana.agw.lab.day0ops.com');
  });
});

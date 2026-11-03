import { test, expect, describe } from 'bun:test';
import { ProfileManager } from '../../src/lib/profiles.js';

const PROFILE_PATH = `${ProfileManager.PROFILES_DIR}/agentgateway-with-keycloak.yaml`;

describe('agentgateway-with-keycloak real DNS wiring', () => {
  test('resolves cert-manager letsencrypt cloudflare config', async () => {
    const profile = await ProfileManager.load(PROFILE_PATH);
    const certManager = profile.addons.find(a => a.name === 'cert-manager');
    expect(certManager.config.letsencrypt.enabled).toBe(true);
    expect(certManager.config.letsencrypt.provider).toBe('cloudflare');
    expect(certManager.config.letsencrypt.email).toBe('kasun.talwatta@solo.io');
  });

  test('adds an external-dns addon pointed at the cloudflare zone', async () => {
    const profile = await ProfileManager.load(PROFILE_PATH);
    const externalDns = profile.addons.find(a => a.name === 'external-dns');
    expect(externalDns).toBeTruthy();
    expect(externalDns.config.provider).toBe('cloudflare');
    expect(externalDns.config.domainFilter).toBe('day0ops.com');
    expect(externalDns.config.txtOwnerId).toBe('agentgateway-demo-local');
  });

  test('keycloak hostname resolves to the real external domain', async () => {
    const profile = await ProfileManager.load(PROFILE_PATH);
    const keycloak = profile.addons.find(a => a.name === 'keycloak');
    expect(keycloak.config.hostname).toBe('keycloak.agw.lab.day0ops.com');
  });

  test('soloUiClients redirect hostname uses https', async () => {
    const profile = await ProfileManager.load(PROFILE_PATH);
    const keycloak = profile.addons.find(a => a.name === 'keycloak');
    expect(keycloak.config.soloUiClients.hostname).toBe('https://solo-ui.agw.lab.day0ops.com');
  });

  test('ui config has no addons entry anymore, lives at the top level', async () => {
    const profile = await ProfileManager.load(PROFILE_PATH);
    expect(profile.addons.find(a => a.name === 'solo-ui')).toBeUndefined();
    expect(profile.ui.enabled).toBe(true);
    expect(profile.ui.serviceType).toBe('LoadBalancer');
    expect(profile.ui.oidc.issuerUrl).toBe('https://keycloak.agw.lab.day0ops.com/realms/solo-ui');
    expect(profile.ui.oidc.backendClientSecret).toBe('solo-ui-backend-secret');
    expect(profile.ui.tracingBackend).toEqual({
      name: 'fan-out-collector',
      namespace: 'telemetry',
      port: 4317,
    });
  });
});

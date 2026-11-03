import { test, expect, describe } from 'bun:test';
import { ProfileManager } from '../../src/lib/profiles.js';

describe('agentgateway-with-solo-ui real DNS wiring', () => {
  test('resolves cert-manager, external-dns, ui, telemetry hostnames', async () => {
    const profile = await ProfileManager.load(
      `${ProfileManager.PROFILES_DIR}/agentgateway-with-solo-ui.yaml`
    );
    const byName = name => profile.addons.find(a => a.name === name);

    expect(byName('cert-manager').config.letsencrypt.provider).toBe('cloudflare');
    expect(byName('external-dns').config.domainFilter).toBe('day0ops.com');
    expect(profile.addons.find(a => a.name === 'solo-ui')).toBeUndefined();
    expect(profile.ui.enabled).toBe(true);
    expect(profile.ui.hostname).toBe('solo-ui.agw.lab.day0ops.com');
    expect(profile.ui.tls.enabled).toBe(true);
    expect(byName('telemetry').config.grafanaHostname).toBe('grafana.agw.lab.day0ops.com');
  });
});

describe('agentgateway-with-observability real DNS wiring', () => {
  test('resolves cert-manager, external-dns, ui, telemetry hostnames', async () => {
    const profile = await ProfileManager.load(
      `${ProfileManager.PROFILES_DIR}/agentgateway-with-observability.yaml`
    );
    const byName = name => profile.addons.find(a => a.name === name);

    expect(byName('cert-manager').config.letsencrypt.provider).toBe('cloudflare');
    expect(byName('external-dns').config.domainFilter).toBe('day0ops.com');
    expect(profile.ui.enabled).toBe(true);
    expect(profile.ui.hostname).toBe('solo-ui.agw.lab.day0ops.com');
    expect(profile.ui.applyGatewayTracingPolicy).toBe(false);
    expect(byName('telemetry').config.grafanaHostname).toBe('grafana.agw.lab.day0ops.com');
  });
});

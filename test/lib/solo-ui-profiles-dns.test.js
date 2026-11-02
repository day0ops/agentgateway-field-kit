import { test, expect, describe } from 'bun:test';
import { ProfileManager } from '../../src/lib/profiles.js';

async function loadByName(file) {
  const profile = await ProfileManager.load(`${ProfileManager.PROFILES_DIR}/${file}`);
  return name => profile.addons.find(a => a.name === name);
}

describe('agentgateway-with-solo-ui real DNS wiring', () => {
  test('resolves cert-manager, external-dns, solo-ui, telemetry hostnames', async () => {
    const byName = await loadByName('agentgateway-with-solo-ui.yaml');

    expect(byName('cert-manager').config.letsencrypt.provider).toBe('cloudflare');
    expect(byName('external-dns').config.domainFilter).toBe('day0ops.com');
    expect(byName('solo-ui').config.hostname).toBe('solo-ui.agw.lab.day0ops.com');
    expect(byName('solo-ui').config.tls.enabled).toBe(true);
    expect(byName('telemetry').config.grafanaHostname).toBe('grafana.agw.lab.day0ops.com');
  });
});

describe('agentgateway-with-observability real DNS wiring', () => {
  test('resolves cert-manager, external-dns, solo-ui, telemetry hostnames', async () => {
    const byName = await loadByName('agentgateway-with-observability.yaml');

    expect(byName('cert-manager').config.letsencrypt.provider).toBe('cloudflare');
    expect(byName('external-dns').config.domainFilter).toBe('day0ops.com');
    expect(byName('solo-ui').config.hostname).toBe('solo-ui.agw.lab.day0ops.com');
    expect(byName('telemetry').config.grafanaHostname).toBe('grafana.agw.lab.day0ops.com');
  });
});

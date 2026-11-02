import { test, expect, describe } from 'bun:test';
import { EnvironmentManager } from '../../src/lib/environment.js';

describe('local environment real DNS config', () => {
  test('exposes a cloudflare dns block', async () => {
    const env = await EnvironmentManager.load('local');
    expect(env.spec.dns.provider).toBe('cloudflare');
    expect(env.spec.dns.parentZone.domain).toBe('day0ops.com');
    expect(env.spec.dns.txtOwnerId).toBe('agentgateway-demo-local');
  });

  test('exposes an acme email', async () => {
    const env = await EnvironmentManager.load('local');
    expect(env.spec.acme.email).toBe('kasun.talwatta@solo.io');
  });

  test('domains.core hostnames are real, not cluster-local', async () => {
    const env = await EnvironmentManager.load('local');
    expect(env.spec.domains.core.keycloak).toBe('keycloak.agw.lab.day0ops.com');
    expect(env.spec.domains.core.soloUi).toBe('solo-ui.agw.lab.day0ops.com');
    expect(env.spec.domains.core.grafana).toBe('grafana.agw.lab.day0ops.com');
    expect(env.spec.domains.core.agentgateway).toBe('agentgateway.agw.lab.day0ops.com');
    expect(env.spec.domains.app.quotaManagement).toBe('quota-management.agw.lab.day0ops.com');
  });

  test('tls.issuer default is unchanged', async () => {
    const env = await EnvironmentManager.load('local');
    expect(env.spec.tls.issuer).toBe('selfsigned-issuer');
  });
});

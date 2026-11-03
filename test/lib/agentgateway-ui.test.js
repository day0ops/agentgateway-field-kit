import { test, expect, describe } from 'bun:test';
import { AgentGatewayManager } from '../../src/lib/agentgateway.js';

describe('AgentGatewayManager.buildUiHelmArgs', () => {
  test('returns ui.enabled=true as the first flag', () => {
    const args = AgentGatewayManager.buildUiHelmArgs({ enabled: true });
    expect(args.slice(0, 2)).toEqual(['--set', 'ui.enabled=true']);
  });

  test('sets oidc issuer and backend secret with --set-string', () => {
    const args = AgentGatewayManager.buildUiHelmArgs({
      enabled: true,
      oidc: {
        enabled: true,
        issuerUrl: 'https://keycloak.example.com/realms/solo-ui',
        backendClientSecret: 'shh',
      },
    });
    expect(args).toContain('--set-string');
    expect(args).toContain('ui.oidc.issuer=https://keycloak.example.com/realms/solo-ui');
    expect(args).toContain('ui.backend.oidc.secret=shh');
  });

  test('omits oidc args when oidc is not configured (built-in autoAuth IdP)', () => {
    const args = AgentGatewayManager.buildUiHelmArgs({ enabled: true });
    expect(args.join(' ')).not.toContain('ui.oidc.issuer');
    expect(args.join(' ')).not.toContain('ui.backend.oidc.secret');
  });

  test('maps serviceType to ui.service.type', () => {
    const args = AgentGatewayManager.buildUiHelmArgs({
      enabled: true,
      serviceType: 'LoadBalancer',
    });
    expect(args).toContain('ui.service.type=LoadBalancer');
  });

  test('maps nodeSelector entries to ui.nodeSelector.<key>', () => {
    const args = AgentGatewayManager.buildUiHelmArgs({
      enabled: true,
      nodeSelector: { nodeclass: 'worker' },
    });
    expect(args).toContain('ui.nodeSelector.nodeclass=worker');
  });

  test('maps features.costManagement.enabled to the flat ui.features.costManagement key', () => {
    const args = AgentGatewayManager.buildUiHelmArgs({
      enabled: true,
      features: { costManagement: { enabled: true } },
    });
    expect(args).toContain('ui.features.costManagement=true');
  });

  test('always enables clickhouse persistence and applies the demo resource overrides', () => {
    const args = AgentGatewayManager.buildUiHelmArgs({ enabled: true });
    expect(args).toContain('ui.clickhouse.persistentVolume.enabled=true');
    expect(args).toContain('ui.clickhouse.resources.requests.cpu=300m');
    expect(args).toContain('ui.clickhouse.resources.requests.memory=1Gi');
  });

  test('maps clickhouse.resources.requests.{cpu,memory} through when set', () => {
    const args = AgentGatewayManager.buildUiHelmArgs({
      enabled: true,
      clickhouse: { resources: { requests: { cpu: '1', memory: '4Gi' } } },
    });
    expect(args).toContain('ui.clickhouse.resources.requests.cpu=1');
    expect(args).toContain('ui.clickhouse.resources.requests.memory=4Gi');
  });

  test('maps clickhouse.persistentVolume.{size,storageClass} through', () => {
    const args = AgentGatewayManager.buildUiHelmArgs({
      enabled: true,
      clickhouse: { persistentVolume: { size: '50Gi', storageClass: 'gp3' } },
    });
    expect(args).toContain('ui.clickhouse.persistentVolume.size=50Gi');
    expect(args).toContain('ui.clickhouse.persistentVolume.storageClass=gp3');
  });
});

describe('AgentGatewayManager.validateUIConfig', () => {
  test('throws when enabled with a hostname but no oidc', () => {
    expect(() =>
      AgentGatewayManager.validateUIConfig({ enabled: true, hostname: 'ui.example.com' })
    ).not.toThrow();
  });

  test('throws when enabled with oidc but missing issuerUrl', () => {
    expect(() =>
      AgentGatewayManager.validateUIConfig({
        enabled: true,
        oidc: { enabled: true, backendClientSecret: 'shh' },
      })
    ).toThrow(/oidc.issuerUrl/);
  });

  test('throws when enabled with oidc but missing backendClientSecret', () => {
    expect(() =>
      AgentGatewayManager.validateUIConfig({
        enabled: true,
        oidc: { enabled: true, issuerUrl: 'https://keycloak.example.com/realms/solo-ui' },
      })
    ).toThrow(/backendClientSecret/);
  });

  test('does not throw when disabled, regardless of other fields', () => {
    expect(() => AgentGatewayManager.validateUIConfig({ enabled: false })).not.toThrow();
    expect(() => AgentGatewayManager.validateUIConfig(null)).not.toThrow();
  });

  test('throws when tracingBackend is missing namespace or port', () => {
    expect(() =>
      AgentGatewayManager.validateUIConfig({
        enabled: true,
        tracingBackend: { name: 'fan-out-collector' },
      })
    ).toThrow(/tracingBackend requires name, namespace, and port/);
  });

  test('does not throw when tracingBackend has all three fields', () => {
    expect(() =>
      AgentGatewayManager.validateUIConfig({
        enabled: true,
        tracingBackend: { name: 'fan-out-collector', namespace: 'telemetry', port: 4317 },
      })
    ).not.toThrow();
  });
});

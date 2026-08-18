import { test, expect, describe } from 'bun:test';
import { AgentGatewayManager } from '../../src/lib/agentgateway.js';

const ENTERPRISE_OCI = 'oci://us-docker.pkg.dev/solo-public/enterprise-agentgateway/charts';

describe('AgentGatewayManager.resolveVersionAndRegistry', () => {
  test('resolves enterprise defaults for a null profile (no --profile flag)', () => {
    const result = AgentGatewayManager.resolveVersionAndRegistry(null);
    expect(result.edition).toBe('enterprise');
    expect(result.ociRegistry).toBe(ENTERPRISE_OCI);
    expect(result.releaseName).toBe('enterprise-agentgateway');
    expect(result.chartName).toBe('enterprise-agentgateway');
    expect(result.crdsReleaseName).toBe('enterprise-agentgateway-crds');
    expect(result.crdsChartName).toBe('enterprise-agentgateway-crds');
  });

  test('a profile omitting spec.edition resolves byte-identically to a profile with edition: enterprise', () => {
    const withoutEdition = AgentGatewayManager.resolveVersionAndRegistry({});
    const withEnterprise = AgentGatewayManager.resolveVersionAndRegistry({ edition: 'enterprise' });
    expect(withoutEdition).toEqual(withEnterprise);
    expect(withoutEdition.edition).toBe('enterprise');
    expect(withoutEdition.ociRegistry).toBe(ENTERPRISE_OCI);
  });

  test('enterprise resolution matches the pre-edition hardcoded defaults exactly', () => {
    const result = AgentGatewayManager.resolveVersionAndRegistry({});
    expect(result).toEqual({
      edition: 'enterprise',
      version: '2.1.1',
      ociRegistry: ENTERPRISE_OCI,
      gatewayApiVersion: 'v1.4.0',
      gatewayApiChannel: 'standard',
      crdsVersion: '2.1.1',
      crdsOciRegistry: ENTERPRISE_OCI,
      crdsHelmValues: null,
      releaseName: 'enterprise-agentgateway',
      chartName: 'enterprise-agentgateway',
      crdsReleaseName: 'enterprise-agentgateway-crds',
      crdsChartName: 'enterprise-agentgateway-crds',
    });
  });

  test('an explicit profile.agentgateway version/registry override wins regardless of edition', () => {
    const result = AgentGatewayManager.resolveVersionAndRegistry({
      edition: 'enterprise',
      agentgateway: { version: '9.9.9', ociRegistry: 'oci://custom/charts' },
    });
    expect(result.version).toBe('9.9.9');
    expect(result.ociRegistry).toBe('oci://custom/charts');
  });

  test('edition: opensource resolves to the OSS chart base name and registry', () => {
    const result = AgentGatewayManager.resolveVersionAndRegistry({ edition: 'opensource' });
    expect(result.edition).toBe('opensource');
    expect(result.ociRegistry).toBe('oci://cr.agentgateway.dev/charts');
    expect(result.releaseName).toBe('agentgateway-oss');
    expect(result.chartName).toBe('agentgateway');
    expect(result.crdsReleaseName).toBe('agentgateway-crds');
    expect(result.crdsChartName).toBe('agentgateway-crds');
  });

  test('an unrecognized edition value falls back to enterprise', () => {
    const result = AgentGatewayManager.resolveVersionAndRegistry({ edition: 'bogus' });
    expect(result.edition).toBe('enterprise');
  });
});

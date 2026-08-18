import { test, expect, describe } from 'bun:test';
import {
  EDITIONS,
  DEFAULT_EDITION,
  resolveEdition,
  EDITION_BASE_NAME,
  EDITION_RELEASE_NAME,
  EDITION_OCI_REGISTRY,
  POLICY_API_GROUP,
  POLICY_KIND,
  PARAMETERS_KIND,
  policyApiVersion,
  CONTROLLER_NAME,
  EDITION_GATEWAY_NAME,
} from '../../src/lib/editions.js';

describe('editions', () => {
  test('EDITIONS contains enterprise and opensource', () => {
    expect(EDITIONS).toEqual(['enterprise', 'opensource']);
  });

  test('DEFAULT_EDITION is enterprise', () => {
    expect(DEFAULT_EDITION).toBe('enterprise');
  });

  test('resolveEdition returns opensource only for the literal "opensource"', () => {
    expect(resolveEdition('opensource')).toBe('opensource');
  });

  test('resolveEdition defaults to enterprise for undefined/null/unknown values', () => {
    expect(resolveEdition(undefined)).toBe('enterprise');
    expect(resolveEdition(null)).toBe('enterprise');
    expect(resolveEdition('enterprise')).toBe('enterprise');
    expect(resolveEdition('bogus')).toBe('enterprise');
  });

  test('EDITION_BASE_NAME maps both editions to their chart base names', () => {
    expect(EDITION_BASE_NAME.enterprise).toBe('enterprise-agentgateway');
    expect(EDITION_BASE_NAME.opensource).toBe('agentgateway');
  });

  test('EDITION_RELEASE_NAME opensource differs from EDITION_BASE_NAME but still contains it (so the chart fullname template resolves to the release name directly)', () => {
    expect(EDITION_RELEASE_NAME.opensource).toBe('agentgateway-oss');
    expect(EDITION_RELEASE_NAME.opensource).toContain(EDITION_BASE_NAME.opensource);
    expect(EDITION_RELEASE_NAME.opensource).not.toBe(EDITION_BASE_NAME.opensource);
  });

  test('EDITION_RELEASE_NAME.enterprise matches EDITION_BASE_NAME.enterprise (no collision risk there)', () => {
    expect(EDITION_RELEASE_NAME.enterprise).toBe(EDITION_BASE_NAME.enterprise);
  });

  test('EDITION_OCI_REGISTRY maps both editions to their OCI registries', () => {
    expect(EDITION_OCI_REGISTRY.enterprise).toBe(
      'oci://us-docker.pkg.dev/solo-public/enterprise-agentgateway/charts'
    );
    expect(EDITION_OCI_REGISTRY.opensource).toBe('oci://cr.agentgateway.dev/charts');
  });

  test('POLICY_KIND and PARAMETERS_KIND map both editions to their CRD kinds', () => {
    expect(POLICY_KIND.enterprise).toBe('EnterpriseAgentgatewayPolicy');
    expect(POLICY_KIND.opensource).toBe('AgentgatewayPolicy');
    expect(PARAMETERS_KIND.enterprise).toBe('EnterpriseAgentgatewayParameters');
    expect(PARAMETERS_KIND.opensource).toBe('AgentgatewayParameters');
  });

  test('policyApiVersion() derives the apiVersion from POLICY_API_GROUP for both editions', () => {
    expect(policyApiVersion('enterprise')).toBe(`${POLICY_API_GROUP.enterprise}/v1alpha1`);
    expect(policyApiVersion('enterprise')).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(policyApiVersion('opensource')).toBe(`${POLICY_API_GROUP.opensource}/v1alpha1`);
    expect(policyApiVersion('opensource')).toBe('agentgateway.dev/v1alpha1');
  });

  test('CONTROLLER_NAME maps both editions to their GatewayClass controllerName', () => {
    expect(CONTROLLER_NAME.enterprise).toBe('solo.io/enterprise-agentgateway');
    expect(CONTROLLER_NAME.opensource).toBe('agentgateway.dev/agentgateway');
  });

  test('EDITION_GATEWAY_NAME gives both editions a Gateway name distinct from their chart/release name', () => {
    expect(EDITION_GATEWAY_NAME.enterprise).toBe('agentgateway-gw');
    expect(EDITION_GATEWAY_NAME.opensource).toBe('agentgateway-oss-gw');
    expect(EDITION_GATEWAY_NAME.enterprise).not.toBe(EDITION_BASE_NAME.enterprise);
    expect(EDITION_GATEWAY_NAME.enterprise).not.toBe(EDITION_RELEASE_NAME.enterprise);
    expect(EDITION_GATEWAY_NAME.opensource).not.toBe(EDITION_BASE_NAME.opensource);
    expect(EDITION_GATEWAY_NAME.opensource).not.toBe(EDITION_RELEASE_NAME.opensource);
  });
});

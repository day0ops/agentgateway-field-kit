import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('SniMatchingFeature', () => {
  test('rejects a hostnames array that is not exactly two entries', async () => {
    await expect(
      FeatureManager.deploy(
        'sni-matching',
        { namespace: 'agentgateway-system', hostnames: ['only-one.local'] },
        { dryRun: true }
      )
    ).rejects.toThrow(/exactly two hostnames/);
  });

  test('builds a dedicated Gateway with two hostname-scoped HTTPS listeners on distinct certs', async () => {
    const docs = await FeatureManager.deploy(
      'sni-matching',
      { namespace: 'agentgateway-system' },
      { dryRun: true }
    );
    const gateway = findDoc(docs, 'Gateway', 'agentgateway-sni');
    expect(gateway.spec.listeners).toHaveLength(2);
    expect(gateway.spec.listeners[0]).toMatchObject({
      hostname: 'alpha.sni-demo.local',
      protocol: 'HTTPS',
      tls: { certificateRefs: [{ name: 'agentgateway-sni-cert-0' }] },
    });
    expect(gateway.spec.listeners[1]).toMatchObject({
      hostname: 'beta.sni-demo.local',
      tls: { certificateRefs: [{ name: 'agentgateway-sni-cert-1' }] },
    });

    expect(findDoc(docs, 'Certificate', 'agentgateway-sni-cert-0').spec.dnsNames).toEqual([
      'alpha.sni-demo.local',
    ]);
    expect(findDoc(docs, 'Certificate', 'agentgateway-sni-cert-1').spec.dnsNames).toEqual([
      'beta.sni-demo.local',
    ]);
  });

  test('creates a third HTTPRoute for the unmatched hostname with no corresponding listener', async () => {
    const docs = await FeatureManager.deploy(
      'sni-matching',
      { namespace: 'agentgateway-system' },
      { dryRun: true }
    );
    const gateway = findDoc(docs, 'Gateway', 'agentgateway-sni');
    const unmatchedRoute = findDoc(docs, 'HTTPRoute', 'agentgateway-sni-c');

    expect(unmatchedRoute.spec.hostnames).toEqual(['gamma.sni-demo.local']);
    const listenerHostnames = gateway.spec.listeners.map(l => l.hostname);
    expect(listenerHostnames).not.toContain('gamma.sni-demo.local');
  });

  test('default backendRef points at mock-provider default EnterpriseAgentgatewayBackend', async () => {
    const docs = await FeatureManager.deploy(
      'sni-matching',
      { namespace: 'agentgateway-system' },
      { dryRun: true }
    );
    const routeA = findDoc(docs, 'HTTPRoute', 'agentgateway-sni-a');
    expect(routeA.spec.rules[0].backendRefs[0]).toEqual({
      name: 'mock-openai-backend',
      group: 'enterpriseagentgateway.solo.io',
      kind: 'EnterpriseAgentgatewayBackend',
    });
  });

  test('edition: opensource default backendRef points at the plain AgentgatewayBackend kind', async () => {
    const docs = await FeatureManager.deploy(
      'sni-matching',
      { namespace: 'agentgateway-system' },
      { dryRun: true, edition: 'opensource' }
    );
    const routeA = findDoc(docs, 'HTTPRoute', 'agentgateway-sni-a');
    expect(routeA.spec.rules[0].backendRefs[0]).toEqual({
      name: 'mock-openai-backend',
      group: 'agentgateway.dev',
      kind: 'AgentgatewayBackend',
    });
  });

  test('config.backendRef overrides the default target', async () => {
    const docs = await FeatureManager.deploy(
      'sni-matching',
      {
        namespace: 'agentgateway-system',
        backendRef: {
          name: 'custom-backend',
          group: 'agentgateway.dev',
          kind: 'AgentgatewayBackend',
        },
      },
      { dryRun: true }
    );
    const routeA = findDoc(docs, 'HTTPRoute', 'agentgateway-sni-a');
    expect(routeA.spec.rules[0].backendRefs[0].name).toBe('custom-backend');
  });
});

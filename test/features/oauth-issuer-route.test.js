import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('OauthIssuerRouteFeature', () => {
  test('wires a /oauth-issuer route to the controller on port 7777, using default names', async () => {
    const docs = await FeatureManager.deploy(
      'oauth-issuer-route',
      { namespace: 'agentgateway-system' },
      { dryRun: true }
    );

    const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'oauth-issuer-backend');
    expect(backend.spec.static).toEqual({
      host: 'enterprise-agentgateway.agentgateway-system.svc.cluster.local',
      port: 7777,
    });

    const route = findDoc(docs, 'HTTPRoute', 'oauth-issuer');
    expect(route.spec.rules[0].matches).toEqual([
      { path: { type: 'PathPrefix', value: '/oauth-issuer' } },
    ]);
    expect(route.spec.rules[0].backendRefs).toEqual([
      {
        group: 'enterpriseagentgateway.solo.io',
        kind: 'EnterpriseAgentgatewayBackend',
        name: 'oauth-issuer-backend',
      },
    ]);
  });

  test('routeName/backendName/pathPrefix are overridable', async () => {
    const docs = await FeatureManager.deploy(
      'oauth-issuer-route',
      {
        namespace: 'agentgateway-system',
        routeName: 'custom-route',
        backendName: 'custom-backend',
        pathPrefix: '/custom-issuer',
      },
      { dryRun: true }
    );

    expect(findDoc(docs, 'EnterpriseAgentgatewayBackend', 'custom-backend')).toBeTruthy();
    const route = findDoc(docs, 'HTTPRoute', 'custom-route');
    expect(route.spec.rules[0].matches).toEqual([
      { path: { type: 'PathPrefix', value: '/custom-issuer' } },
    ]);
    expect(route.spec.rules[0].backendRefs[0].name).toBe('custom-backend');
  });

  test('cleanup() never deletes the shared route/backend', async () => {
    // This is shared infrastructure across multiple usecases - cleanup() must be a
    // no-op regardless of dryRun, since Feature.deploy()'s dryRun path never reaches
    // cleanup(), so we call it directly here.
    const { OauthIssuerRouteFeature } = await import('../../features/oauth-issuer-route/index.js');
    const feature = new OauthIssuerRouteFeature('oauth-issuer-route', {
      namespace: 'agentgateway-system',
      dryRun: true,
    });
    await expect(feature.cleanup()).resolves.toBeUndefined();
  });
});

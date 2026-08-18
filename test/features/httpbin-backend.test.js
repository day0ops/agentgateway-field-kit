import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('HttpbinBackendFeature', () => {
  test('deploys a Deployment and Service using the default name/image/port', async () => {
    const docs = await FeatureManager.deploy(
      'httpbin-backend',
      { namespace: 'agentgateway-system' },
      { dryRun: true }
    );

    const deployment = findDoc(docs, 'Deployment', 'httpbin-backend');
    expect(deployment.spec.template.spec.containers[0].image).toBe('kennethreitz/httpbin');
    expect(deployment.spec.template.spec.containers[0].ports).toEqual([{ containerPort: 80 }]);

    const service = findDoc(docs, 'Service', 'httpbin-backend');
    expect(service.spec.selector).toEqual({ app: 'httpbin-backend' });
    expect(service.spec.ports).toEqual([{ port: 80, targetPort: 80 }]);
    // matchLabels-based discovery (mcp-enterprise/mcp-server) matches the Service's own
    // metadata.labels, not just spec.selector.
    expect(service.metadata.labels.app).toBe('httpbin-backend');
  });

  test('config.name/image/port override the defaults', async () => {
    const docs = await FeatureManager.deploy(
      'httpbin-backend',
      {
        namespace: 'agentgateway-system',
        name: 'echo-upstream',
        image: 'my/httpbin:1.0',
        port: 8080,
      },
      { dryRun: true }
    );

    const deployment = findDoc(docs, 'Deployment', 'echo-upstream');
    expect(deployment.spec.template.spec.containers[0].image).toBe('my/httpbin:1.0');
    expect(deployment.spec.template.spec.containers[0].ports).toEqual([{ containerPort: 8080 }]);

    const service = findDoc(docs, 'Service', 'echo-upstream');
    expect(service.spec.selector).toEqual({ app: 'echo-upstream' });
    expect(service.spec.ports).toEqual([{ port: 8080, targetPort: 8080 }]);
  });
});

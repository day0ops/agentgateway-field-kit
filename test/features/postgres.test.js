import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';
import { PostgresFeature } from '../../features/postgres/index.js';

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('PostgresFeature', () => {
  test('deploys Secret, Service, PVC, and Deployment using the defaults', async () => {
    const docs = await FeatureManager.deploy(
      'postgres',
      { namespace: 'agentgateway-system' },
      { dryRun: true }
    );

    const secret = findDoc(docs, 'Secret', 'postgres');
    expect(secret.stringData).toEqual({
      POSTGRES_USER: 'tokenexchange',
      POSTGRES_PASSWORD: 'tokenexchange',
      POSTGRES_DB: 'tokenexchange',
    });

    const service = findDoc(docs, 'Service', 'postgres');
    expect(service.spec.selector).toEqual({ app: 'postgres' });
    expect(service.spec.ports).toEqual([{ port: 5432, targetPort: 5432, name: 'postgres' }]);

    const pvc = findDoc(docs, 'PersistentVolumeClaim', 'postgres');
    expect(pvc.spec.resources.requests.storage).toBe('5Gi');

    const deployment = findDoc(docs, 'Deployment', 'postgres');
    const container = deployment.spec.template.spec.containers[0];
    expect(container.image).toBe('postgres:18-alpine');
    expect(container.ports).toEqual([{ containerPort: 5432 }]);
    expect(container.envFrom).toEqual([{ secretRef: { name: 'postgres' } }]);
  });

  test('config overrides name/image/port/user/password/database', async () => {
    const docs = await FeatureManager.deploy(
      'postgres',
      {
        namespace: 'agentgateway-system',
        name: 'my-postgres',
        image: 'postgres:16-alpine',
        port: 5433,
        user: 'myuser',
        password: 'mypass',
        database: 'mydb',
      },
      { dryRun: true }
    );

    const secret = findDoc(docs, 'Secret', 'my-postgres');
    expect(secret.stringData).toEqual({
      POSTGRES_USER: 'myuser',
      POSTGRES_PASSWORD: 'mypass',
      POSTGRES_DB: 'mydb',
    });

    const deployment = findDoc(docs, 'Deployment', 'my-postgres');
    const container = deployment.spec.template.spec.containers[0];
    expect(container.image).toBe('postgres:16-alpine');
    expect(container.ports).toEqual([{ containerPort: 5433 }]);
  });

  test('connectionUrl matches the deployed Service/Secret coordinates', () => {
    const feature = new PostgresFeature('postgres', {
      namespace: 'agentgateway-system',
      name: 'my-postgres',
      port: 5433,
      user: 'myuser',
      password: 'mypass',
      database: 'mydb',
    });
    expect(feature.connectionUrl).toBe(
      'postgres://myuser:mypass@my-postgres.agentgateway-system.svc.cluster.local:5433/mydb?sslmode=disable'
    );
  });
});

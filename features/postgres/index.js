import { Feature } from '../../src/lib/feature.js';

const DEFAULT_IMAGE = 'postgres:18-alpine';
const DEFAULT_PORT = 5432;

/**
 * Postgres Feature
 *
 * Deploys a throwaway, usecase-scoped Postgres (Secret+Service+PVC+Deployment) -
 * for the token-exchange feature's STS database, which otherwise has no dedicated
 * per-usecase instance. Extracted from auth-only-mcp's own inline deployPostgres()
 * (kept there unchanged) after a real crash-loop: token-exchange's Helm upgrades
 * always use --reuse-values and only ever *set* database.postgres.url, never clear
 * it, so a usecase whose token-exchange config omits `database` silently inherits
 * whatever Postgres URL a different, since-cleaned-up usecase last configured - the
 * controller then crash-loops on DNS resolution failure for the deleted Service.
 * Every usecase using the raw token-exchange feature should deploy its own Postgres
 * via this feature and pass connectionUrl explicitly, rather than relying on
 * whatever a previous usecase happened to leave configured.
 *
 * Configuration:
 * {
 *   name: string,      // Resource name prefix (default: 'postgres')
 *   image: string,     // Container image (default: 'postgres:18-alpine')
 *   port: number,      // Container/service port (default: 5432)
 *   user: string,      // POSTGRES_USER (default: 'tokenexchange')
 *   password: string,  // POSTGRES_PASSWORD (default: 'tokenexchange')
 *   database: string,  // POSTGRES_DB (default: 'tokenexchange')
 * }
 */
export class PostgresFeature extends Feature {
  get prefix() {
    return this.config.name || 'postgres';
  }

  get image() {
    return this.config.image || DEFAULT_IMAGE;
  }

  get port() {
    return this.config.port || DEFAULT_PORT;
  }

  get user() {
    return this.config.user || 'tokenexchange';
  }

  get password() {
    return this.config.password || 'tokenexchange';
  }

  get database() {
    return this.config.database || 'tokenexchange';
  }

  get labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
    };
  }

  get serviceHost() {
    return `${this.prefix}.${this.namespace}.svc.cluster.local`;
  }

  get connectionUrl() {
    return `postgres://${this.user}:${this.password}@${this.serviceHost}:${this.port}/${this.database}?sslmode=disable`;
  }

  async deploy() {
    this.log(`Deploying Postgres '${this.prefix}'...`, 'info');

    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: this.prefix, namespace: this.namespace, labels: this.labels },
      type: 'Opaque',
      stringData: {
        POSTGRES_USER: this.user,
        POSTGRES_PASSWORD: this.password,
        POSTGRES_DB: this.database,
      },
    };
    await this.applyResource(secret);

    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: this.prefix,
        namespace: this.namespace,
        labels: { ...this.labels, app: this.prefix },
      },
      spec: {
        selector: { app: this.prefix },
        ports: [{ port: this.port, targetPort: this.port, name: 'postgres' }],
      },
    };
    await this.applyResource(service);

    const pvc = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: this.prefix, namespace: this.namespace, labels: this.labels },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: '5Gi' } },
      },
    };
    await this.applyResource(pvc);

    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: this.prefix,
        namespace: this.namespace,
        labels: { ...this.labels, app: this.prefix },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: this.prefix } },
        template: {
          metadata: { labels: { app: this.prefix } },
          spec: {
            containers: [
              {
                name: 'postgres',
                image: this.image,
                ports: [{ containerPort: this.port }],
                envFrom: [{ secretRef: { name: this.prefix } }],
                volumeMounts: [{ name: 'data', mountPath: '/var/lib/postgresql' }],
                readinessProbe: {
                  exec: { command: ['pg_isready', '-U', this.user] },
                  initialDelaySeconds: 5,
                  periodSeconds: 5,
                },
              },
            ],
            volumes: [{ name: 'data', persistentVolumeClaim: { claimName: this.prefix } }],
          },
        },
      },
    };
    await this.applyResource(deployment);

    this.log(`Postgres '${this.prefix}' deployed`, 'success');
  }

  async cleanup() {
    this.log(`Cleaning up Postgres '${this.prefix}'...`, 'info');
    await this.deleteResource('Deployment', this.prefix, this.namespace);
    await this.deleteResource('Service', this.prefix, this.namespace);
    await this.deleteResource('PersistentVolumeClaim', this.prefix, this.namespace);
    await this.deleteResource('Secret', this.prefix, this.namespace);
    this.log(`Postgres '${this.prefix}' cleaned up`, 'success');
  }
}

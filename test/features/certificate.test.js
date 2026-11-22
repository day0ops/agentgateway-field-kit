import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';

describe('CertificateFeature issuer passthrough', () => {
  test('defaults to selfsigned-issuer when issuer is omitted', async () => {
    const docs = await FeatureManager.deploy(
      'certificate',
      { name: 'my-cert', secretName: 'my-cert-tls', dnsNames: ['example.local'] },
      { dryRun: true }
    );
    const cert = yaml.load(docs[0]);
    expect(cert.spec.issuerRef.name).toBe('selfsigned-issuer');
  });

  test('an explicit issuer overrides the default', async () => {
    const docs = await FeatureManager.deploy(
      'certificate',
      {
        name: 'my-cert',
        secretName: 'my-cert-tls',
        dnsNames: ['example.local'],
        issuer: 'letsencrypt-dns',
      },
      { dryRun: true }
    );
    const cert = yaml.load(docs[0]);
    expect(cert.spec.issuerRef.name).toBe('letsencrypt-dns');
  });
});

describe('CertificateFeature waits for Ready', () => {
  let originalKubectl, calls;

  beforeEach(() => {
    calls = [];
    originalKubectl = KubernetesHelper.kubectl;
  });

  afterEach(() => {
    KubernetesHelper.kubectl = originalKubectl;
  });

  test('deploy resolves once the Certificate reports Ready on the first poll', async () => {
    KubernetesHelper.kubectl = async args => {
      calls.push(args);
      if (args[0] === 'get' && args[1] === 'certificate') {
        return { stdout: 'True', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    await FeatureManager.deploy(
      'certificate',
      { name: 'my-cert', secretName: 'my-cert-tls', dnsNames: ['example.local'] },
      { dryRun: false }
    );

    const readyChecks = calls.filter(args => args[0] === 'get' && args[1] === 'certificate');
    expect(readyChecks.length).toBe(1);
  });
});

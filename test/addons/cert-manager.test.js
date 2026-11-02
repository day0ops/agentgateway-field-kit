import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { CertManagerFeature } from '../../addons/cert-manager/index.js';
import { envVarsFor, generate } from '../../addons/cert-manager/runbook.js';

describe('CertManagerFeature letsencrypt.provider', () => {
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;

  beforeEach(() => {
    delete process.env.CLOUDFLARE_API_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalToken;
  });

  test('defaults to route53', () => {
    const feature = new CertManagerFeature('cert-manager', {});
    expect(feature.letsencryptProvider).toBe('route53');
  });

  test('validate() throws when provider is cloudflare and CLOUDFLARE_API_TOKEN is unset', () => {
    const feature = new CertManagerFeature('cert-manager', {
      letsencrypt: { enabled: true, provider: 'cloudflare', email: 'test@example.com' },
    });
    expect(() => feature.validate()).toThrow(/CLOUDFLARE_API_TOKEN/);
  });

  test('validate() passes once CLOUDFLARE_API_TOKEN is set', () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    const feature = new CertManagerFeature('cert-manager', {
      letsencrypt: { enabled: true, provider: 'cloudflare', email: 'test@example.com' },
    });
    expect(feature.validate()).toBe(true);
  });

  test('validate() does not require CLOUDFLARE_API_TOKEN for route53', () => {
    const feature = new CertManagerFeature('cert-manager', {
      letsencrypt: { enabled: true, email: 'test@example.com' },
    });
    expect(feature.validate()).toBe(true);
  });
});

describe('cert-manager runbook.js cloudflare branch', () => {
  test('envVarsFor requires CLOUDFLARE_API_TOKEN when provider is cloudflare', () => {
    const vars = envVarsFor({ letsencrypt: { enabled: true, provider: 'cloudflare' } });
    expect(vars.some(v => v.name === 'CLOUDFLARE_API_TOKEN' && v.required)).toBe(true);
  });

  test('envVarsFor is empty for route53', () => {
    const vars = envVarsFor({ letsencrypt: { enabled: true, provider: 'route53' } });
    expect(vars).toEqual([]);
  });

  test('generate() includes the Cloudflare secret and solver when provider is cloudflare', async () => {
    const md = await generate(0, {
      letsencrypt: { enabled: true, provider: 'cloudflare', email: 'test@example.com' },
    });
    expect(md).toContain('cert-manager-cloudflare-api-token');
    expect(md).toContain('cloudflare:');
  });

  test('generate() falls back to route53 when provider is omitted', async () => {
    const md = await generate(0, { letsencrypt: { enabled: true, email: 'test@example.com' } });
    expect(md).toContain('route53:');
    expect(md).not.toContain('cloudflare');
  });
});

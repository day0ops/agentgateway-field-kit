import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { ExternalDnsFeature } from '../../addons/external-dns/index.js';
import { envVarsFor, generate } from '../../addons/external-dns/runbook.js';

describe('ExternalDnsFeature provider', () => {
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;

  beforeEach(() => {
    delete process.env.CLOUDFLARE_API_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalToken;
  });

  test('defaults to route53', () => {
    const feature = new ExternalDnsFeature('external-dns', { domainFilter: 'example.com' });
    expect(feature.provider).toBe('route53');
  });

  test('validate() rejects an unsupported provider', () => {
    const feature = new ExternalDnsFeature('external-dns', {
      provider: 'azure',
      domainFilter: 'example.com',
    });
    expect(() => feature.validate()).toThrow(/not yet supported/);
  });

  test('validate() throws when provider is cloudflare and CLOUDFLARE_API_TOKEN is unset', () => {
    const feature = new ExternalDnsFeature('external-dns', {
      provider: 'cloudflare',
      domainFilter: 'example.com',
    });
    expect(() => feature.validate()).toThrow(/CLOUDFLARE_API_TOKEN/);
  });

  test('validate() passes once CLOUDFLARE_API_TOKEN is set', () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    const feature = new ExternalDnsFeature('external-dns', {
      provider: 'cloudflare',
      domainFilter: 'example.com',
    });
    expect(feature.validate()).toBe(true);
  });

  test('cloudflareProxied defaults to false', () => {
    const feature = new ExternalDnsFeature('external-dns', {
      provider: 'cloudflare',
      domainFilter: 'example.com',
    });
    expect(feature.cloudflareProxied).toBe(false);
  });
});

describe('external-dns runbook.js cloudflare branch', () => {
  test('envVarsFor requires CLOUDFLARE_API_TOKEN when provider is cloudflare', () => {
    const vars = envVarsFor({ provider: 'cloudflare', domainFilter: 'example.com' });
    expect(vars.some(v => v.name === 'CLOUDFLARE_API_TOKEN' && v.required)).toBe(true);
  });

  test('envVarsFor is empty for route53', () => {
    const vars = envVarsFor({ provider: 'route53', domainFilter: 'example.com' });
    expect(vars).toEqual([]);
  });

  test('generate() includes the Cloudflare secret and provider.name when provider is cloudflare', async () => {
    const md = await generate(0, { provider: 'cloudflare', domainFilter: 'example.com' });
    expect(md).toContain('external-dns-cloudflare-api-token');
    expect(md).toContain('provider.name=cloudflare');
  });

  test('generate() falls back to route53 when provider is omitted', async () => {
    const md = await generate(0, { domainFilter: 'example.com' });
    expect(md).toContain('provider.name=aws');
  });

  test('generate() includes --cloudflare-proxied only when proxied is true', async () => {
    const proxied = await generate(0, {
      provider: 'cloudflare',
      domainFilter: 'example.com',
      proxied: true,
    });
    expect(proxied).toContain('--cloudflare-proxied');

    const notProxied = await generate(0, { provider: 'cloudflare', domainFilter: 'example.com' });
    expect(notProxied).not.toContain('--cloudflare-proxied');
  });
});

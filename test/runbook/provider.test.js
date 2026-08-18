import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { ProviderAdapter } from '../../src/lib/runbook-adapters/provider.js';

// Set placeholder env vars so dryRun doesn't fail on missing credentials
const savedVars = {};
beforeAll(() => {
  const keys = [
    'OPENAI_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GCP_PROJECT',
    'GCP_LOCATION',
    'ANTHROPIC_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
  ];
  for (const k of keys) {
    savedVars[k] = process.env[k];
    process.env[k] = process.env[k] || `<${k}>`;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedVars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('ProviderAdapter', () => {
  test('envVarsFor([openai]) returns OPENAI_API_KEY as required', () => {
    const vars = ProviderAdapter.envVarsFor(['openai']);
    const k = vars.find(v => v.name === 'OPENAI_API_KEY');
    expect(k).toBeDefined();
    expect(k.required).toBe(true);
  });

  test('envVarsFor([bedrock]) returns AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY', () => {
    const vars = ProviderAdapter.envVarsFor(['bedrock']);
    expect(vars.find(v => v.name === 'AWS_ACCESS_KEY_ID')).toBeDefined();
    expect(vars.find(v => v.name === 'AWS_SECRET_ACCESS_KEY')).toBeDefined();
  });

  test('envVarsFor([vertex-ai]) returns GCP vars', () => {
    const vars = ProviderAdapter.envVarsFor(['vertex-ai']);
    expect(vars.find(v => v.name === 'GCP_PROJECT')).toBeDefined();
    expect(vars.find(v => v.name === 'GOOGLE_APPLICATION_CREDENTIALS')).toBeDefined();
  });

  test('generate([openai]) returns Lab N heading', async () => {
    const section = await ProviderAdapter.generate(['openai'], 1);
    expect(section).toContain('## Lab 1: Providers');
  });

  test('generate([openai]) contains yaml code block', async () => {
    const section = await ProviderAdapter.generate(['openai'], 1);
    expect(section).toContain('```yaml');
  });

  test('generate([openai]) contains providers-already-deployed note', async () => {
    const section = await ProviderAdapter.generate(['openai'], 1);
    expect(section.toLowerCase()).toContain('deploy once');
  });

  test('envVarsFor deduplicates across multiple providers', () => {
    // openai and bedrock share no vars — just verify count is correct
    const vars = ProviderAdapter.envVarsFor(['openai', 'bedrock']);
    const names = vars.map(v => v.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('OPENAI_API_KEY');
    expect(names).toContain('AWS_ACCESS_KEY_ID');
  });

  test('envVarsFor([]) returns empty array', () => {
    expect(ProviderAdapter.envVarsFor([])).toEqual([]);
  });

  test('generate([], 0) returns just the heading and note', async () => {
    const section = await ProviderAdapter.generate([], 0);
    expect(section).toContain('## Lab 0: Providers');
    expect(section.toLowerCase()).toContain('deploy once');
  });
});

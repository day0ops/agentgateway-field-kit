import { test, expect, describe } from 'bun:test';
import { WalkthroughSchema } from '../../src/lib/walkthrough-schema.js';

describe('WalkthroughSchema.validate', () => {
  test('passes for a minimal valid document', () => {
    const doc = {
      apiVersion: 'agentgateway.demo/v1',
      kind: 'Walkthrough',
      metadata: { name: 'demo' },
      spec: { screens: [{ name: 'one' }] },
    };
    expect(WalkthroughSchema.validate(doc)).toEqual({ valid: true, errors: [] });
  });

  test('fails when apiVersion is wrong', () => {
    const doc = {
      apiVersion: 'v1',
      kind: 'Walkthrough',
      metadata: { name: 'demo' },
      spec: { screens: [{}] },
    };
    const result = WalkthroughSchema.validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('apiVersion');
  });

  test('fails when kind is wrong', () => {
    const doc = {
      apiVersion: 'agentgateway.demo/v1',
      kind: 'UseCase',
      metadata: { name: 'demo' },
      spec: { screens: [{}] },
    };
    expect(WalkthroughSchema.validate(doc).valid).toBe(false);
  });

  test('fails when metadata.name is missing', () => {
    const doc = {
      apiVersion: 'agentgateway.demo/v1',
      kind: 'Walkthrough',
      metadata: {},
      spec: { screens: [{}] },
    };
    expect(WalkthroughSchema.validate(doc).valid).toBe(false);
  });

  test('fails when spec.screens is missing or empty', () => {
    const base = {
      apiVersion: 'agentgateway.demo/v1',
      kind: 'Walkthrough',
      metadata: { name: 'demo' },
    };
    expect(WalkthroughSchema.validate({ ...base, spec: {} }).valid).toBe(false);
    expect(WalkthroughSchema.validate({ ...base, spec: { screens: [] } }).valid).toBe(false);
  });
});

describe('WalkthroughSchema.normalize', () => {
  test('returns spec for a valid document', () => {
    const doc = {
      apiVersion: 'agentgateway.demo/v1',
      kind: 'Walkthrough',
      metadata: { name: 'demo' },
      spec: { screens: [{ name: 'one' }] },
    };
    expect(WalkthroughSchema.normalize(doc)).toEqual({ screens: [{ name: 'one' }] });
  });

  test('throws for an invalid document', () => {
    expect(() => WalkthroughSchema.normalize({ kind: 'Walkthrough' })).toThrow(/validation failed/);
  });
});

describe('WalkthroughSchema accessors', () => {
  test('getName / getDescription', () => {
    const doc = { metadata: { name: 'demo', description: '  A demo walkthrough  ' } };
    expect(WalkthroughSchema.getName(doc)).toBe('demo');
    expect(WalkthroughSchema.getDescription(doc)).toBe('A demo walkthrough');
  });

  test('getDescription returns null when absent', () => {
    expect(WalkthroughSchema.getDescription({ metadata: {} })).toBe(null);
  });
});

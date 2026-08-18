import { test, expect, describe } from 'bun:test';
import { ProfileSchema } from '../../src/lib/profile-schema.js';

function baseProfile(spec = {}) {
  return {
    apiVersion: 'agentgateway.demo/v1',
    kind: 'Profile',
    metadata: { name: 'test-profile' },
    spec,
  };
}

describe('ProfileSchema.validate edition check', () => {
  test('profile with no spec.edition is valid', () => {
    const { valid, errors } = ProfileSchema.validate(baseProfile({}));
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });

  test('spec.edition: enterprise is valid', () => {
    const { valid } = ProfileSchema.validate(baseProfile({ edition: 'enterprise' }));
    expect(valid).toBe(true);
  });

  test('spec.edition: opensource is valid', () => {
    const { valid } = ProfileSchema.validate(baseProfile({ edition: 'opensource' }));
    expect(valid).toBe(true);
  });

  test('an unrecognized spec.edition value fails validation', () => {
    const { valid, errors } = ProfileSchema.validate(baseProfile({ edition: 'community' }));
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('Invalid spec.edition'))).toBe(true);
  });

  test('normalize() flattens spec.edition to a top-level edition field', () => {
    const normalized = ProfileSchema.normalize(baseProfile({ edition: 'opensource' }));
    expect(normalized.edition).toBe('opensource');
  });
});

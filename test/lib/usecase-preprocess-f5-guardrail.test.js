import { test, expect, describe } from 'bun:test';
import { UseCaseManager } from '../../src/lib/usecase.js';

describe('preprocessFeatures targetRefs auto-injection for f5-guardrail', () => {
  test('injects targetRefs from the providers step when none is set', () => {
    const spec = {
      features: [
        { name: 'providers', config: { providers: [{ name: 'openai' }] } },
        { name: 'f5-guardrail', config: {} },
      ],
    };
    UseCaseManager.preprocessFeatures(spec);
    const feature = spec.features.find(f => f.name === 'f5-guardrail');
    expect(feature.config.targetRefs).toEqual([
      { group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'openai' },
    ]);
  });

  test('does not override an explicitly-set targetRefs', () => {
    const explicit = [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'custom' }];
    const spec = {
      features: [
        { name: 'providers', config: { providers: [{ name: 'openai' }] } },
        { name: 'f5-guardrail', config: { targetRefs: explicit } },
      ],
    };
    UseCaseManager.preprocessFeatures(spec);
    const feature = spec.features.find(f => f.name === 'f5-guardrail');
    expect(feature.config.targetRefs).toEqual(explicit);
  });
});

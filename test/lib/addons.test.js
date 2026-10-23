import { test, expect, describe } from 'bun:test';
import { AddonInstaller } from '../../src/lib/addons.js';

describe('AddonInstaller.orderForCleanup', () => {
  test('moves aws-load-balancer-controller to the end', () => {
    const addons = [
      { name: 'aws-load-balancer-controller', namespace: 'kube-system' },
      { name: 'cert-manager', namespace: 'cert-manager' },
      { name: 'keycloak', namespace: 'keycloak' },
      { name: 'external-dns', namespace: 'external-dns' },
    ];
    const ordered = AddonInstaller.orderForCleanup(addons);
    expect(ordered.map(a => a.name)).toEqual([
      'cert-manager',
      'keycloak',
      'external-dns',
      'aws-load-balancer-controller',
    ]);
  });

  test('is a no-op when aws-load-balancer-controller is absent', () => {
    const addons = [
      { name: 'cert-manager', namespace: 'cert-manager' },
      { name: 'keycloak', namespace: 'keycloak' },
    ];
    expect(AddonInstaller.orderForCleanup(addons).map(a => a.name)).toEqual([
      'cert-manager',
      'keycloak',
    ]);
  });

  test('handles an empty list', () => {
    expect(AddonInstaller.orderForCleanup([])).toEqual([]);
  });
});

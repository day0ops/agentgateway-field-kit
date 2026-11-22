import { test, expect, describe } from 'bun:test';
import { AddonInstaller } from '../../src/lib/addons.js';

describe('AddonInstaller.orderForCleanup', () => {
  test('moves aws-load-balancer-controller, cert-manager, and external-dns to the end, in that priority order', () => {
    const addons = [
      { name: 'aws-load-balancer-controller', namespace: 'kube-system' },
      { name: 'cert-manager', namespace: 'cert-manager' },
      { name: 'keycloak', namespace: 'keycloak' },
      { name: 'external-dns', namespace: 'external-dns' },
      { name: 'telemetry', namespace: 'telemetry' },
    ];
    const ordered = AddonInstaller.orderForCleanup(addons);
    expect(ordered.map(a => a.name)).toEqual([
      'keycloak',
      'telemetry',
      'cert-manager',
      'external-dns',
      'aws-load-balancer-controller',
    ]);
  });

  test('aws-load-balancer-controller is last even without cert-manager/external-dns present', () => {
    const addons = [
      { name: 'aws-load-balancer-controller', namespace: 'kube-system' },
      { name: 'keycloak', namespace: 'keycloak' },
    ];
    expect(AddonInstaller.orderForCleanup(addons).map(a => a.name)).toEqual([
      'keycloak',
      'aws-load-balancer-controller',
    ]);
  });

  test('cert-manager and external-dns move to the end even without aws-load-balancer-controller present', () => {
    const addons = [
      { name: 'cert-manager', namespace: 'cert-manager' },
      { name: 'keycloak', namespace: 'keycloak' },
      { name: 'external-dns', namespace: 'external-dns' },
    ];
    expect(AddonInstaller.orderForCleanup(addons).map(a => a.name)).toEqual([
      'keycloak',
      'cert-manager',
      'external-dns',
    ]);
  });

  test('is a no-op when none of the three deferred addons are present', () => {
    const addons = [
      { name: 'keycloak', namespace: 'keycloak' },
      { name: 'telemetry', namespace: 'telemetry' },
    ];
    expect(AddonInstaller.orderForCleanup(addons).map(a => a.name)).toEqual([
      'keycloak',
      'telemetry',
    ]);
  });

  test('handles an empty list', () => {
    expect(AddonInstaller.orderForCleanup([])).toEqual([]);
  });
});

describe('AddonInstaller.splitForGatewayTeardown', () => {
  test('pulls external-dns and aws-load-balancer-controller out, in that order', () => {
    const addons = [
      { name: 'aws-load-balancer-controller', namespace: 'kube-system' },
      { name: 'cert-manager', namespace: 'cert-manager' },
      { name: 'keycloak', namespace: 'keycloak' },
      { name: 'external-dns', namespace: 'external-dns' },
      { name: 'telemetry', namespace: 'telemetry' },
    ];
    const { before, after } = AddonInstaller.splitForGatewayTeardown(addons);
    expect(before.map(a => a.name)).toEqual(['cert-manager', 'keycloak', 'telemetry']);
    expect(after.map(a => a.name)).toEqual(['external-dns', 'aws-load-balancer-controller']);
  });

  test('is a no-op when neither addon is present', () => {
    const addons = [
      { name: 'keycloak', namespace: 'keycloak' },
      { name: 'telemetry', namespace: 'telemetry' },
    ];
    const { before, after } = AddonInstaller.splitForGatewayTeardown(addons);
    expect(before).toEqual(addons);
    expect(after).toEqual([]);
  });

  test('handles an empty list', () => {
    expect(AddonInstaller.splitForGatewayTeardown([])).toEqual({ before: [], after: [] });
  });
});

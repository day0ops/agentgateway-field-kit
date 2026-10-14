import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { KeycloakFeature } from '../../addons/keycloak/index.js';

const REQUIRED_BASE_ENV = {
  KEYCLOAK_ADMIN_USERNAME: 'admin',
  KEYCLOAK_ADMIN_PASSWORD: 'admin-pass',
  KEYCLOAK_POSTGRES_USER: 'postgres',
  KEYCLOAK_POSTGRES_PASSWORD: 'postgres-pass',
};

const ENV_KEYS = [...Object.keys(REQUIRED_BASE_ENV), 'KEYCLOAK_DEFAULT_PASSWORD'];
const originalEnv = {};

describe('KeycloakFeature.validate() password requirements', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(REQUIRED_BASE_ENV)) {
      process.env[key] = value;
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  test('throws naming KEYCLOAK_DEFAULT_PASSWORD when realms are configured but it is unset', () => {
    const feature = new KeycloakFeature('keycloak', {
      realms: [{ realm: 'agw-dev', users: [{ username: 'user1' }] }],
    });
    expect(() => feature.validate()).toThrow(/KEYCLOAK_DEFAULT_PASSWORD/);
  });

  test('passes once KEYCLOAK_DEFAULT_PASSWORD is set', () => {
    process.env.KEYCLOAK_DEFAULT_PASSWORD = 'Password1!';
    const feature = new KeycloakFeature('keycloak', {
      realms: [{ realm: 'agw-dev', users: [{ username: 'user1' }] }],
    });
    expect(feature.validate()).toBe(true);
  });

  test('does not require KEYCLOAK_DEFAULT_PASSWORD when no realms are configured', () => {
    const feature = new KeycloakFeature('keycloak', {});
    expect(feature.validate()).toBe(true);
  });
});

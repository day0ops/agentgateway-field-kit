import { EDITIONS } from './editions.js';

export const ProfileSchema = {
  validate(profile, source = 'profile') {
    const errors = [];

    if (!profile.apiVersion) {
      errors.push(`${source}: Missing required field: apiVersion`);
    } else if (profile.apiVersion !== 'agentgateway.demo/v1') {
      errors.push(
        `${source}: Invalid apiVersion: ${profile.apiVersion}. Expected: agentgateway.demo/v1`
      );
    }

    if (!profile.kind) {
      errors.push(`${source}: Missing required field: kind`);
    } else if (profile.kind !== 'Profile') {
      errors.push(`${source}: Invalid kind: ${profile.kind}. Expected: Profile`);
    }

    if (!profile.metadata) {
      errors.push(`${source}: Missing required field: metadata`);
    } else if (!profile.metadata.name) {
      errors.push(`${source}: Missing required field: metadata.name`);
    }

    if (!profile.spec) {
      errors.push(`${source}: Missing required field: spec`);
    } else if (profile.spec.edition !== undefined && !EDITIONS.includes(profile.spec.edition)) {
      errors.push(
        `${source}: Invalid spec.edition: ${profile.spec.edition}. Expected one of: ${EDITIONS.join(', ')}`
      );
    }

    return { valid: errors.length === 0, errors };
  },

  normalize(profile, source = 'profile') {
    if (!profile || typeof profile !== 'object') {
      throw new Error(`${source}: Invalid profile document`);
    }

    // Legacy flat profiles (pre-Profile CRD shape)
    if (!profile.apiVersion && !profile.kind) {
      return profile;
    }

    const validation = this.validate(profile, source);
    if (!validation.valid) {
      throw new Error(`Profile validation failed:\n  - ${validation.errors.join('\n  - ')}`);
    }

    return profile.spec || {};
  },

  getName(profile) {
    return profile.metadata?.name || null;
  },

  getDescription(profile) {
    const description = profile.metadata?.description;
    if (!description) {
      return null;
    }
    return typeof description === 'string' ? description.trim() : String(description).trim();
  },

  getDescriptionSummary(profile) {
    const description = this.getDescription(profile);
    if (!description) {
      return null;
    }
    const firstLine = description
      .split('\n')
      .map(line => line.trim())
      .find(Boolean);
    return firstLine || null;
  },
};

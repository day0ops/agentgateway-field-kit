/** Validation and accessors for the Walkthrough document kind. */
export const WalkthroughSchema = {
  validate(walkthrough, source = 'walkthrough') {
    const errors = [];

    if (!walkthrough.apiVersion) {
      errors.push(`${source}: Missing required field: apiVersion`);
    } else if (walkthrough.apiVersion !== 'agentgateway.demo/v1') {
      errors.push(
        `${source}: Invalid apiVersion: ${walkthrough.apiVersion}. Expected: agentgateway.demo/v1`
      );
    }

    if (!walkthrough.kind) {
      errors.push(`${source}: Missing required field: kind`);
    } else if (walkthrough.kind !== 'Walkthrough') {
      errors.push(`${source}: Invalid kind: ${walkthrough.kind}. Expected: Walkthrough`);
    }

    if (!walkthrough.metadata) {
      errors.push(`${source}: Missing required field: metadata`);
    } else if (!walkthrough.metadata.name) {
      errors.push(`${source}: Missing required field: metadata.name`);
    }

    if (!walkthrough.spec) {
      errors.push(`${source}: Missing required field: spec`);
    } else if (!Array.isArray(walkthrough.spec.screens) || walkthrough.spec.screens.length === 0) {
      errors.push(`${source}: spec.screens must be a non-empty array`);
    }

    return { valid: errors.length === 0, errors };
  },

  normalize(walkthrough, source = 'walkthrough') {
    if (!walkthrough || typeof walkthrough !== 'object') {
      throw new Error(`${source}: Invalid walkthrough document`);
    }
    const validation = this.validate(walkthrough, source);
    if (!validation.valid) {
      throw new Error(`Walkthrough validation failed:\n  - ${validation.errors.join('\n  - ')}`);
    }
    return walkthrough.spec;
  },

  getName(walkthrough) {
    return walkthrough.metadata?.name || null;
  },

  getDescription(walkthrough) {
    const description = walkthrough.metadata?.description;
    if (!description) return null;
    return typeof description === 'string' ? description.trim() : String(description).trim();
  },
};

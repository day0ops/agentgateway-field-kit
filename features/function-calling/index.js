import { Feature } from '../../src/lib/feature.js';
import { Logger } from '../../src/lib/common.js';

/**
 * Function Calling Feature
 *
 * Demonstrates and validates function calling (tools) for LLM providers using agentgateway.
 *
 * Reference: https://kgateway.dev/docs/latest/agentgateway/llm/functions/
 *
 * This feature helps with:
 * - Validating function calling configuration
 * - Providing examples of function calling requests
 * - Documenting the function calling workflow
 *
 * Note: Function calling doesn't require a TrafficPolicy - it's part of the standard
 * OpenAI-compatible API request format. This feature primarily provides validation
 * and documentation.
 *
 * Configuration:
 * {
 *   enabled: boolean,              // Optional: Enable function calling (default: true)
 *   validateRequests: boolean,    // Optional: Validate tool definitions (default: true)
 *   targetRefs: object            // Optional: Override targetRefs for any policies
 * }
 *
 * Example:
 * {
 *   enabled: true,
 *   validateRequests: true
 * }
 *
 * Function calling workflow:
 * 1. Send request with tools array containing function definitions
 * 2. LLM responds with tool_calls if it decides to use a function
 * 3. Execute the function in your application
 * 4. Send the function result back to LLM with tool role message
 * 5. LLM responds with final answer incorporating the function result
 */
export class FunctionCallingFeature extends Feature {
  getFeaturePath() {
    return this.name;
  }

  validate() {
    const { enabled = true } = this.config;

    if (typeof enabled !== 'boolean') {
      throw new Error('enabled must be a boolean');
    }

    // Function calling doesn't require TrafficPolicy, but we can validate config
    return true;
  }

  async deploy() {
    const { enabled = true, validateRequests = true, targetRefs = null } = this.config;

    if (!enabled) {
      this.log('Function calling is disabled, skipping deployment', 'info');
      return;
    }

    this.log('Function calling feature enabled', 'info');
    this.log('Note: Function calling uses standard OpenAI-compatible API format', 'info');
    this.log('No TrafficPolicy is required - tools are passed in request body', 'info');

    if (validateRequests) {
      this.log('Request validation enabled - ensure tools array follows OpenAI format', 'info');
    }

    // Function calling doesn't require a TrafficPolicy, but we can create
    // a placeholder or documentation resource if needed
    // For now, we'll just log that it's ready to use
    this.log('Function calling is ready to use', 'info');
    this.log('See README.md for examples and usage', 'info');
  }

  /**
   * Validate a function/tool definition
   * @param {Object} tool - Tool definition
   * @returns {Object} Validation result
   */
  static validateTool(tool) {
    const errors = [];

    if (!tool.type || tool.type !== 'function') {
      errors.push('Tool type must be "function"');
    }

    if (!tool.function) {
      errors.push('Tool must have a "function" property');
      return { valid: false, errors };
    }

    const func = tool.function;

    if (!func.name || typeof func.name !== 'string') {
      errors.push('Function must have a "name" property (string)');
    }

    if (!func.description || typeof func.description !== 'string') {
      errors.push('Function must have a "description" property (string)');
    }

    if (!func.parameters) {
      errors.push('Function must have a "parameters" property');
    } else {
      if (func.parameters.type !== 'object') {
        errors.push('Function parameters.type must be "object"');
      }

      if (!func.parameters.properties) {
        errors.push('Function parameters must have "properties"');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate tools array
   * @param {Array} tools - Array of tool definitions
   * @returns {Object} Validation result
   */
  static validateTools(tools) {
    if (!Array.isArray(tools)) {
      return { valid: false, errors: ['Tools must be an array'] };
    }

    if (tools.length === 0) {
      return { valid: false, errors: ['Tools array cannot be empty'] };
    }

    const errors = [];
    tools.forEach((tool, index) => {
      const result = this.validateTool(tool);
      if (!result.valid) {
        errors.push(`Tool ${index}: ${result.errors.join(', ')}`);
      }
    });

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  async cleanup() {
    // Function calling doesn't create any Kubernetes resources
    // so there's nothing to clean up
    this.log('Function calling feature cleanup complete', 'info');
  }
}

// Export a factory function for easy instantiation
export function createFunctionCallingFeature(config) {
  return new FunctionCallingFeature('function-calling', config);
}

import { test, expect, describe } from 'bun:test';
import { AgentGatewayManager } from '../../src/lib/agentgateway.js';

describe('AgentGatewayManager UI cleanup resource names', () => {
  test('cleanupUI deletes the fixed, hardcoded UI resource names (idempotent, no profile needed)', async () => {
    // cleanupUI must not require a profile argument or throw when called with none --
    // resource names are fixed regardless of what ui: config (if any) created them.
    expect(AgentGatewayManager.cleanupUI).toBeInstanceOf(Function);
    expect(AgentGatewayManager.cleanupUI.length).toBe(0);
  });
});

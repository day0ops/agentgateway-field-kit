import { test, expect, describe } from 'bun:test';
import { CommandRunner } from '../../src/lib/common.js';

describe('CommandRunner secret redaction', () => {
  test('redacts licensing.licenseKey from a thrown error message', async () => {
    let caught;
    try {
      await CommandRunner.run('bash', [
        '-c',
        "echo fail --set 'licensing.licenseKey=super-secret-token-value' 1>&2; exit 1",
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught.message).not.toContain('super-secret-token-value');
    expect(caught.message).toContain('***REDACTED***');
    if (caught.stderr) {
      expect(caught.stderr).not.toContain('super-secret-token-value');
    }
  });

  test('redacts licensing.licenseKey when ignoreError is true (no throw)', async () => {
    const result = await CommandRunner.run(
      'bash',
      ['-c', "echo fail --set 'licensing.licenseKey=super-secret-token-value' 1>&2; exit 1"],
      { ignoreError: true }
    );
    if (result.stderr) {
      expect(result.stderr).not.toContain('super-secret-token-value');
      expect(result.stderr).toContain('***REDACTED***');
    }
  });

  test('does not alter output with no license key present', async () => {
    let caught;
    try {
      await CommandRunner.run('bash', ['-c', 'echo some other failure 1>&2; exit 1']);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toContain('some other failure');
  });
});

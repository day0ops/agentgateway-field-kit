import { test, expect, describe, afterAll } from 'bun:test';
import { mkdtempSync } from 'fs';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { UseCaseManager } from '../../src/lib/usecase.js';

const MINIMAL_SPEC =
  'apiVersion: agentgateway.demo/v1\nkind: UseCase\nmetadata:\n  name: x\nspec: {}\n';

async function writeUsecase(root, relativeDir, filename) {
  const dir = join(root, 'config', 'usecases', relativeDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), MINIMAL_SPEC);
}

describe('UseCaseManager resolver (current flat layout)', () => {
  let tmpRoot;

  afterAll(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  test('list() defaults edition to enterprise for unprefixed paths', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'uc-flat-'));
    await writeUsecase(tmpRoot, 'security', 'apikey-auth.yaml');
    const usecases = await UseCaseManager.list(tmpRoot);
    const uc = usecases.find(u => u.name === 'apikey-auth');
    expect(uc.edition).toBe('enterprise');
    expect(uc.category).toBe('security');
  });

  test('get() resolves a bare name unprefixed', async () => {
    const uc = await UseCaseManager.get('apikey-auth', tmpRoot);
    expect(uc.name).toBe('apikey-auth');
    expect(uc.category).toBe('security');
  });

  test('get() resolves 2-segment category/name unprefixed', async () => {
    const uc = await UseCaseManager.get('security/apikey-auth', tmpRoot);
    expect(uc.name).toBe('apikey-auth');
  });

  test('get() throws not found for unknown name', async () => {
    await expect(UseCaseManager.get('does-not-exist', tmpRoot)).rejects.toThrow(/not found/);
  });

  test('get() still detects ambiguity across categories for a bare name', async () => {
    await writeUsecase(tmpRoot, 'routing', 'apikey-auth.yaml');
    await expect(UseCaseManager.get('apikey-auth', tmpRoot)).rejects.toThrow(/Ambiguous/);
  });
});

describe('UseCaseManager resolver (edition-prefixed layout)', () => {
  let tmpRoot;

  afterAll(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  test('list() strips a recognized edition prefix before computing category', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'uc-editions-'));
    await writeUsecase(tmpRoot, 'enterprise/security', 'mcp-auth.yaml');
    await writeUsecase(tmpRoot, 'opensource/security', 'mcp-auth.yaml');
    await writeUsecase(tmpRoot, 'opensource/mcp', 'static-mcp-server.yaml');

    const usecases = await UseCaseManager.list(tmpRoot);
    const entMcpAuth = usecases.find(u => u.edition === 'enterprise' && u.name === 'mcp-auth');
    const ossMcpAuth = usecases.find(u => u.edition === 'opensource' && u.name === 'mcp-auth');
    const ossStatic = usecases.find(u => u.name === 'static-mcp-server');

    expect(entMcpAuth.category).toBe('security');
    expect(ossMcpAuth.category).toBe('security');
    expect(ossStatic.edition).toBe('opensource');
    expect(ossStatic.category).toBe('mcp');
  });

  test('get() with a bare name prefers the enterprise match when exactly one exists', async () => {
    const uc = await UseCaseManager.get('mcp-auth', tmpRoot);
    expect(uc.edition).toBe('enterprise');
  });

  test('get() with unprefixed category/name prefers the enterprise match', async () => {
    const uc = await UseCaseManager.get('security/mcp-auth', tmpRoot);
    expect(uc.edition).toBe('enterprise');
  });

  test('get() with an explicit opensource/category/name prefix resolves the opensource match', async () => {
    const uc = await UseCaseManager.get('opensource/security/mcp-auth', tmpRoot);
    expect(uc.edition).toBe('opensource');
  });

  test('get() with an explicit opensource/name prefix resolves an unambiguous opensource-only entry', async () => {
    const uc = await UseCaseManager.get('opensource/static-mcp-server', tmpRoot);
    expect(uc.edition).toBe('opensource');
    expect(uc.category).toBe('mcp');
  });

  test('get() bare name resolves an unambiguous opensource-only entry without a prefix', async () => {
    const uc = await UseCaseManager.get('static-mcp-server', tmpRoot);
    expect(uc.edition).toBe('opensource');
  });

  test('get() throws ambiguous when an edition-prefixed reference matches nothing in that edition', async () => {
    await expect(UseCaseManager.get('opensource/routing/mcp-auth', tmpRoot)).rejects.toThrow(
      /not found/
    );
  });
});

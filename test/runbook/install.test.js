// test/runbook/install.test.js
import { test, expect, describe } from 'bun:test';
import { mkdtempSync } from 'fs';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { InstallAdapter } from '../../src/lib/runbook-adapters/install.js';

describe('InstallAdapter', () => {
  test('envVars() returns ENTERPRISE_AGENTGATEWAY_LICENSE as required', () => {
    const vars = InstallAdapter.envVars();
    const licenseVar = vars.find(v => v.name === 'ENTERPRISE_AGENTGATEWAY_LICENSE');
    expect(licenseVar).toBeDefined();
    expect(licenseVar.required).toBe(true);
  });

  test('generate() returns string containing Lab 0 heading', async () => {
    const section = await InstallAdapter.generate({ addons: [], labNum: 0 });
    expect(section).toContain('## Lab 0: Installation');
  });

  test('generate() contains helm upgrade command for agentgateway', async () => {
    const section = await InstallAdapter.generate({ addons: [], labNum: 0 });
    expect(section).toContain('helm upgrade');
    expect(section).toContain('enterprise-agentgateway');
    expect(section).toContain('ENTERPRISE_AGENTGATEWAY_LICENSE');
  });

  test('generate() contains Gateway API CRD install URL with version', async () => {
    const section = await InstallAdapter.generate({ addons: [], labNum: 0 });
    expect(section).toContain('gateway-api/releases/download');
    expect(section).toContain('standard-install.yaml');
  });

  test('generate() contains agentgateway CRDs helm install', async () => {
    const section = await InstallAdapter.generate({ addons: [], labNum: 0 });
    expect(section).toContain('enterprise-agentgateway-crds');
    expect(section).toContain('${AGW_OCI_REGISTRY}');
  });

  test('generate() does not include addon sections when addons is empty', async () => {
    const section = await InstallAdapter.generate({ addons: [], labNum: 0 });
    expect(section).not.toContain('### Install Telemetry');
    expect(section).not.toContain('### Install cert-manager');
  });

  test('generate() without profile uses default versions', async () => {
    const section = await InstallAdapter.generate({ labNum: 0 });
    expect(section).toContain('## Lab 0: Installation');
    expect(section).toContain('standard-install.yaml');
    expect(section).toContain('enterprise-agentgateway-crds');
  });

  test('generate() with profile uses profile versions in prose and envExports', async () => {
    const profileData = {
      agentgateway: { version: '9.9.9', ociRegistry: 'oci://custom.registry/charts' },
      gatewayApi: { version: 'v9.0.0' },
    };
    const section = await InstallAdapter.generate({ labNum: 0, profileData });
    // The prose text for Gateway API CRDs shows the resolved version
    expect(section).toContain('v9.0.0');
    // Env exports carry the actual version values
    const exports = InstallAdapter.envExports(profileData);
    expect(exports.find(e => e.key === 'AGW_VERSION').value).toBe('9.9.9');
    expect(exports.find(e => e.key === 'AGW_OCI_REGISTRY').value).toBe(
      'oci://custom.registry/charts'
    );
    expect(exports.find(e => e.key === 'GATEWAY_API_VERSION').value).toBe('v9.0.0');
  });

  test('generate() with experimental channel uses experimental-install.yaml', async () => {
    const profileData = { gatewayApi: { version: 'v1.5.0', channel: 'experimental' } };
    const section = await InstallAdapter.generate({ labNum: 0, profileData });
    expect(section).toContain('experimental-install.yaml');
    expect(section).not.toContain('standard-install.yaml');
  });

  test('generate() with helmValues renders heredoc <<EOF format', async () => {
    const profileData = {
      helmValues: { controller: { extraEnv: { FOO: 'bar' } } },
    };
    const section = await InstallAdapter.generate({ labNum: 0, profileData });
    expect(section).toContain('<<EOF');
    expect(section).not.toContain("<<'EOF'");
    expect(section).toContain('FOO');
    expect(section).not.toContain('values.yaml');
  });

  test('generate() with helmValues puts --set licenseKey before --values heredoc', async () => {
    const profileData = {
      helmValues: { controller: { extraEnv: { FOO: 'bar' } } },
    };
    const section = await InstallAdapter.generate({ labNum: 0, profileData });
    const licensePos = section.indexOf('$ENTERPRISE_AGENTGATEWAY_LICENSE');
    const heredocPos = section.indexOf('--values - <<EOF');
    expect(licensePos).toBeGreaterThan(-1);
    expect(heredocPos).toBeGreaterThan(-1);
    expect(licensePos).toBeLessThan(heredocPos);
  });

  test('generate() without helmValues has no heredoc and includes --wait', async () => {
    const section = await InstallAdapter.generate({ labNum: 0 });
    expect(section).not.toContain('<<EOF');
    expect(section).toContain('--wait --timeout 5m');
  });

  test('generate() with resources renders apply section', async () => {
    const profileData = {
      resources: ['agentgateway-with-keycloak/enterprise-agentgateway-sharedext-params.yaml'],
    };
    const section = await InstallAdapter.generate({ labNum: 0, profileData });
    expect(section).toContain('Apply Additional Resources');
    expect(section).toContain('kubectl apply -f - <<EOF');
    expect(section).not.toContain("kubectl apply -f - <<'EOF'");
    expect(section).toContain('EnterpriseAgentgatewayParameters');
  });

  test('generate() with missing resource outputs comment fallback', async () => {
    const profileData = {
      resources: ['nonexistent-profile/does-not-exist.yaml'],
    };
    const section = await InstallAdapter.generate({ labNum: 0, profileData });
    expect(section).toContain(
      '# (resource not found: config/profiles/nonexistent-profile/does-not-exist.yaml)'
    );
  });

  test('envExports() returns AGW_VERSION, AGW_OCI_REGISTRY, GATEWAY_API_VERSION, namespace settings', () => {
    const exports = InstallAdapter.envExports();
    const keys = exports.map(e => e.key);
    expect(keys).toContain('AGW_VERSION');
    expect(keys).toContain('AGW_OCI_REGISTRY');
    expect(keys).toContain('GATEWAY_API_VERSION');
    expect(keys).toContain('AGW_NAMESPACE');
    expect(keys).toContain('AGW_RELEASE');
    expect(keys).toContain('AGW_CRDS_RELEASE');
    expect(exports.find(e => e.key === 'AGW_NAMESPACE').value).toBe('agentgateway-system');
    expect(exports.find(e => e.key === 'AGW_RELEASE').value).toBe('enterprise-agentgateway');
    expect(exports.find(e => e.key === 'AGW_CRDS_RELEASE').value).toBe(
      'enterprise-agentgateway-crds'
    );
  });

  test('envExports() groups: AGW_VERSION=versions, AGW_OCI_REGISTRY=registry, AGW_NAMESPACE=settings', () => {
    const exports = InstallAdapter.envExports();
    expect(exports.find(e => e.key === 'AGW_VERSION').group).toBe('versions');
    expect(exports.find(e => e.key === 'AGW_OCI_REGISTRY').group).toBe('registry');
    expect(exports.find(e => e.key === 'AGW_NAMESPACE').group).toBe('settings');
  });

  test('envExports() omits AGW_CRDS_VERSION when crdsVersion equals version', () => {
    const exports = InstallAdapter.envExports();
    expect(exports.find(e => e.key === 'AGW_CRDS_VERSION')).toBeUndefined();
  });

  test('envExports() includes AGW_CRDS_VERSION when crdsVersion differs from version', () => {
    const profileData = {
      agentgateway: { version: '2.1.1' },
      'agentgateway-crds': { version: '2.0.0' },
    };
    const exports = InstallAdapter.envExports(profileData);
    expect(exports.find(e => e.key === 'AGW_CRDS_VERSION')).toBeDefined();
    expect(exports.find(e => e.key === 'AGW_CRDS_VERSION').value).toBe('2.0.0');
  });

  test('generate() with projectRoot finds resources in that root', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'install-root-'));
    const profileDir = join(tmpRoot, 'config', 'profiles', 'test-profile');
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, 'resource.yaml'),
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: portability-test-cm\n'
    );
    try {
      const section = await InstallAdapter.generate({
        labNum: 0,
        profileData: { resources: ['test-profile/resource.yaml'] },
        projectRoot: tmpRoot,
      });
      expect(section).toContain('portability-test-cm');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('generate() does not contain ### Set environment variables section', async () => {
    const section = await InstallAdapter.generate({ labNum: 0 });
    expect(section).not.toContain('### Set environment variables');
  });

  test('generate() uses $VARNAME in helm commands', async () => {
    const section = await InstallAdapter.generate({ labNum: 0 });
    expect(section).toContain('${AGW_NAMESPACE}');
    expect(section).toContain('${AGW_VERSION}');
    expect(section).toContain('${AGW_OCI_REGISTRY}');
    expect(section).toContain('${GATEWAY_API_VERSION}');
    expect(section).toContain('${AGW_RELEASE}');
    expect(section).toContain('${AGW_CRDS_RELEASE}');
  });

  test('generate() always includes license key set flag', async () => {
    const section = await InstallAdapter.generate({ labNum: 0 });
    expect(section).toContain('$ENTERPRISE_AGENTGATEWAY_LICENSE');
  });

  test('versions() without profile returns defaults', () => {
    const v = InstallAdapter.versions();
    expect(v.agwVersion).toBeTruthy();
    expect(v.gatewayApiVersion).toBeTruthy();
    expect(v.agwOci).toContain('oci://');
  });

  test('versions() with profileData returns overridden values', () => {
    const profileData = {
      agentgateway: { version: '3.0.0', ociRegistry: 'oci://my-registry/charts' },
      gatewayApi: { version: 'v2.0.0' },
    };
    const v = InstallAdapter.versions(profileData);
    expect(v.agwVersion).toBe('3.0.0');
    expect(v.agwOci).toBe('oci://my-registry/charts');
    expect(v.gatewayApiVersion).toBe('v2.0.0');
  });

  describe('opensource edition', () => {
    const profileData = { edition: 'opensource' };

    test('envVars() marks the license var as not required', () => {
      const vars = InstallAdapter.envVars(profileData);
      const licenseVar = vars.find(v => v.name === 'ENTERPRISE_AGENTGATEWAY_LICENSE');
      expect(licenseVar.required).toBe(false);
    });

    test('envVars() without profileData still requires the license var (enterprise default)', () => {
      const vars = InstallAdapter.envVars();
      const licenseVar = vars.find(v => v.name === 'ENTERPRISE_AGENTGATEWAY_LICENSE');
      expect(licenseVar.required).toBe(true);
    });

    test('envExports() resolves the OSS registry and release names', () => {
      const exports = InstallAdapter.envExports(profileData);
      expect(exports.find(e => e.key === 'AGW_OCI_REGISTRY').value).toBe(
        'oci://cr.agentgateway.dev/charts'
      );
      expect(exports.find(e => e.key === 'AGW_RELEASE').value).toBe('agentgateway-oss');
      expect(exports.find(e => e.key === 'AGW_CRDS_RELEASE').value).toBe('agentgateway-crds');
    });

    test('versions() resolves edition and OSS release names', () => {
      const v = InstallAdapter.versions(profileData);
      expect(v.edition).toBe('opensource');
      expect(v.agwOci).toBe('oci://cr.agentgateway.dev/charts');
      expect(v.agwRelease).toBe('agentgateway-oss');
      expect(v.agwCrdsRelease).toBe('agentgateway-crds');
    });

    test('generate() uses the OSS chart names and omits the license key flag', async () => {
      const section = await InstallAdapter.generate({ labNum: 0, profileData });
      expect(section).toContain('${AGW_OCI_REGISTRY}/agentgateway-crds');
      expect(section).toContain('${AGW_OCI_REGISTRY}/agentgateway \\');
      expect(section).not.toContain('licensing.licenseKey');
      expect(section).not.toContain('enterprise-agentgateway');
    });
  });
});

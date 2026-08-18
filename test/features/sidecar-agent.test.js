import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

const config = {
  namespace: 'agentgateway-system',
  agentName: 'stock-agent',
};

function docByKind(docs, kind) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind);
}

describe('SidecarAgentFeature edition branching', () => {
  test('enterprise (default) emits the enterprise GatewayClass controllerName and Parameters kind', async () => {
    const docs = await FeatureManager.deploy('sidecar-agent', config, { dryRun: true });

    const gatewayClass = docByKind(docs, 'GatewayClass');
    expect(gatewayClass.spec.controllerName).toBe('solo.io/enterprise-agentgateway');

    const params = docByKind(docs, 'EnterpriseAgentgatewayParameters');
    expect(params.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(params.spec.deployment.spec.template.spec.containers[0].name).toBe('stock-agent');

    const gateway = docByKind(docs, 'Gateway');
    expect(gateway.spec.infrastructure.parametersRef).toEqual({
      name: 'stock-agent-params',
      group: 'enterpriseagentgateway.solo.io',
      kind: 'EnterpriseAgentgatewayParameters',
    });
  });

  test('edition: enterprise resolves identically to omitting the edition option', async () => {
    const withoutEdition = await FeatureManager.deploy('sidecar-agent', config, { dryRun: true });
    const withEnterprise = await FeatureManager.deploy('sidecar-agent', config, {
      dryRun: true,
      edition: 'enterprise',
    });
    expect(withoutEdition).toEqual(withEnterprise);
  });

  test('edition: opensource emits the OSS GatewayClass controllerName and Parameters kind', async () => {
    const docs = await FeatureManager.deploy('sidecar-agent', config, {
      dryRun: true,
      edition: 'opensource',
    });

    const gatewayClass = docByKind(docs, 'GatewayClass');
    expect(gatewayClass.spec.controllerName).toBe('agentgateway.dev/agentgateway');

    const params = docByKind(docs, 'AgentgatewayParameters');
    expect(params.apiVersion).toBe('agentgateway.dev/v1alpha1');
    expect(params.spec.deployment.spec.template.spec.containers[0].name).toBe('stock-agent');

    const gateway = docByKind(docs, 'Gateway');
    expect(gateway.spec.infrastructure.parametersRef).toEqual({
      name: 'stock-agent-params',
      group: 'agentgateway.dev',
      kind: 'AgentgatewayParameters',
    });
  });
});

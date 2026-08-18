import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';
import { ModelCostsFeature } from '../../features/model-costs/index.js';

const catalog = {
  providers: {
    openai: {
      models: {
        'gpt-4o-mini': {
          rates: {
            input: '0.15',
            output: '0.6',
            cacheRead: '0.075',
            cacheWrite: '0.0',
            reasoning: '0.0',
            inputAudio: '0.0',
            outputAudio: '0.0',
          },
        },
      },
    },
  },
};

describe('ModelCostsFeature', () => {
  test('catalog round-trips into the ConfigMap and EnterpriseAgentgatewayParameters references it', async () => {
    const docs = await FeatureManager.deploy('model-costs', { catalog }, { dryRun: true });

    const configMapDoc = docs.map(d => yaml.load(d)).find(d => d?.kind === 'ConfigMap');
    const parametersDoc = docs
      .map(d => yaml.load(d))
      .find(d => d?.kind === 'EnterpriseAgentgatewayParameters');

    expect(configMapDoc).toBeTruthy();
    expect(JSON.parse(configMapDoc.data['catalog.json'])).toEqual(catalog);

    expect(parametersDoc).toBeTruthy();
    expect(parametersDoc.spec.modelCatalog.sources[0].configMap.name).toBe(
      configMapDoc.metadata.name
    );
    expect(parametersDoc.spec.modelCatalog.sources[0].configMap.key).toBe('catalog.json');
  });

  test('a custom configMapName/parametersName/catalogKey flow through consistently', async () => {
    const docs = await FeatureManager.deploy(
      'model-costs',
      {
        catalog,
        configMapName: 'custom-catalog',
        parametersName: 'custom-params',
        catalogKey: 'prices.json',
      },
      { dryRun: true }
    );

    const configMapDoc = docs.map(d => yaml.load(d)).find(d => d?.kind === 'ConfigMap');
    const parametersDoc = docs
      .map(d => yaml.load(d))
      .find(d => d?.kind === 'EnterpriseAgentgatewayParameters');

    expect(configMapDoc.metadata.name).toBe('custom-catalog');
    expect(configMapDoc.data['prices.json']).toBeTruthy();
    expect(configMapDoc.data['catalog.json']).toBeUndefined();

    expect(parametersDoc.metadata.name).toBe('custom-params');
    expect(parametersDoc.spec.modelCatalog.sources[0].configMap).toEqual({
      name: 'custom-catalog',
      key: 'prices.json',
    });
  });

  test('validate() throws when both catalog and catalogFile are set', () => {
    const feature = new ModelCostsFeature('model-costs', {
      catalog,
      catalogFile: '/tmp/catalog.json',
    });
    expect(() => feature.validate()).toThrow(/either catalog or catalogFile, not both/);
  });

  test('validate() throws when neither catalog nor catalogFile is set', () => {
    const feature = new ModelCostsFeature('model-costs', {});
    expect(() => feature.validate()).toThrow(/either catalog or catalogFile is required/);
  });

  test('validate() throws on out-of-order tiers', () => {
    const feature = new ModelCostsFeature('model-costs', {
      catalog: {
        providers: {
          'gcp.gemini': {
            models: {
              'gemini-2.5-pro': {
                rates: { input: '1.25', output: '10' },
                tiers: [
                  { contextOver: 200000, rates: { input: '2.5', output: '15' } },
                  { contextOver: 100000, rates: { input: '3', output: '20' } },
                ],
              },
            },
          },
        },
      },
    });
    expect(() => feature.validate()).toThrow(/tiers must be ordered by ascending contextOver/);
  });

  test('validate() accepts ascending tiers', () => {
    const feature = new ModelCostsFeature('model-costs', {
      catalog: {
        providers: {
          'gcp.gemini': {
            models: {
              'gemini-2.5-pro': {
                rates: { input: '1.25', output: '10' },
                tiers: [{ contextOver: 200000, rates: { input: '2.5', output: '15' } }],
              },
            },
          },
        },
      },
    });
    expect(() => feature.validate()).not.toThrow();
  });
});

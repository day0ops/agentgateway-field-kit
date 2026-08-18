import { Feature } from '../../src/lib/feature.js';

const DEFAULT_DISALLOWED_MODELS = ['gpt-4'];
const DEFAULT_STATUS_CODE = 403;
const DEFAULT_MESSAGE = 'Request blocked by WAF policy';

/**
 * WAF Feature
 *
 * Applies a WAFPolicy (Coraza/ModSecurity-compatible rules) that inspects the JSON
 * request body for a disallowed `model` field, plus an EnterpriseAgentgatewayPolicy
 * that attaches it to one or more routes via traffic.entWAF.wafPolicyRef.
 *
 * Prerequisite (cluster/profile-level, not something this feature can flip itself):
 * the GatewayClass's EnterpriseAgentgatewayParameters must have
 * sharedExtensions.waf.enabled: true, or the shared waf-server never starts and this
 * policy silently has no effect. See
 * config/profiles/agentgateway-with-keycloak/enterprise-agentgateway-sharedext-params.yaml
 * and https://docs.solo.io/agentgateway/latest/security/waf/enable/.
 *
 * Configuration:
 * {
 *   name: string,               // WAFPolicy/EnterpriseAgentgatewayPolicy name (default: 'waf-policy')
 *   disallowedModels: string[], // Model names to block via ARGS:json.model (default: ['gpt-4'])
 *   statusCode: number,         // Block response status (default: 403)
 *   message: string,            // Block response body message
 *   targetRefs: [{ group, kind, name }], // Required - routes/gateway this policy applies to
 * }
 */
export class WafFeature extends Feature {
  get wafPolicyName() {
    return this.config.name || 'waf-policy';
  }

  get disallowedModels() {
    return this.config.disallowedModels || DEFAULT_DISALLOWED_MODELS;
  }

  get statusCode() {
    return this.config.statusCode || DEFAULT_STATUS_CODE;
  }

  get message() {
    return this.config.message || DEFAULT_MESSAGE;
  }

  get targetRefs() {
    return this.config.targetRefs || [];
  }

  get labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
    };
  }

  async deploy() {
    // Checked here rather than in validate() - validate() is skipped during dry-run
    // (FeatureManager.deploy only needs YAML there), and this should catch a
    // misconfigured usecase in `agw usecase dryrun` too, not just a real deploy.
    if (this.targetRefs.length === 0) {
      throw new Error('waf requires at least one entry in config.targetRefs');
    }

    this.log('Deploying WAF policy...', 'info');
    await this.deployWafPolicy();
    await this.deployTrafficPolicy();
    this.log(
      'WAF policy deployed (requires sharedExtensions.waf.enabled: true at the profile/GatewayClass level to take effect)',
      'success'
    );
  }

  async deployWafPolicy() {
    // Scoping the block rule to ARGS:json.model (not bare ARGS) avoids matching every
    // request field that happens to contain a disallowed model's name as a substring.
    const modelPattern = this.disallowedModels.join('|');

    const policy = {
      apiVersion: 'waf.solo.io/v1alpha1',
      kind: 'WAFPolicy',
      metadata: {
        name: this.wafPolicyName,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        processingConfig: {
          request: { mode: 'HeadersAndBody' },
        },
        ruleEngineSettings: {
          inline:
            'SecRuleEngine On\n' +
            'SecRule REQUEST_HEADERS:Content-Type "^application/json" ' +
            '"id:200001,phase:1,t:none,t:lowercase,pass,nolog,ctl:requestBodyProcessor=JSON"\n',
        },
        customDirectives: [
          {
            inline:
              `SecRule ARGS:json.model "@rx ^(${modelPattern})$" ` +
              `"deny,status:${this.statusCode},id:200101,phase:2,msg:'${this.message}'"\n`,
          },
        ],
        customInterventionResponse: {
          statusCode: this.statusCode,
          headers: {
            setHeaders: [{ name: 'x-blocked-by', value: 'waf-policy' }],
          },
          body: JSON.stringify({ error: this.message }),
        },
      },
    };

    await this.applyResource(policy);
  }

  async deployTrafficPolicy() {
    const policy = {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: {
        name: this.wafPolicyName,
        namespace: this.namespace,
        labels: this.labels,
      },
      spec: {
        targetRefs: this.targetRefs,
        traffic: {
          entWAF: {
            wafPolicyRef: { name: this.wafPolicyName, namespace: this.namespace },
          },
        },
      },
    };

    await this.applyResource(policy);
  }

  async cleanup() {
    this.log('Cleaning up waf feature...', 'info');
    // PolicyRegistry coalescing may have merged/renamed the EnterpriseAgentgatewayPolicy
    // (e.g. 'waf-openai' instead of this.wafPolicyName) - delete by label, not by name.
    await this.deleteByLabel('EnterpriseAgentgatewayPolicy', {
      'agentgateway.dev/feature': this.name,
    });
    await this.deleteResource('WAFPolicy', this.wafPolicyName, this.namespace);
    this.log('waf feature cleaned up', 'success');
  }
}

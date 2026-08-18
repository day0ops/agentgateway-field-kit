import { Feature } from '../../src/lib/feature.js';

/**
 * Elicitation Secret Feature
 *
 * Creates a Kubernetes secret holding the external OAuth provider's client
 * secret, for use with the agentgateway elicitation flow (see
 * elicitation-backend). This enables agents to request user authorization for
 * external APIs (e.g., GitHub, Google) on behalf of users.
 *
 * Reference: https://docs.solo.io/agentgateway/latest/mcp/token-exchange/elicitations/setup/
 *
 * Only the client secret lives in this Secret - the rest of the OAuth client
 * config (client ID, authorize/access-token URLs, scopes, redirect URI) is
 * typed, literal config on elicitation-backend's `backend.entElicitation`
 * field. Earlier releases stored all of it as opaque Secret keys referenced by
 * the now-deprecated `backend.tokenExchange.elicitation.secretName`; per
 * Solo's migration notes, only `client_secret` remains in the Secret under
 * `entElicitation`.
 *
 * Configuration:
 * {
 *   secretName: string,              // Secret name (default: 'elicitation-oauth')
 *   provider: string,                // Provider name for labeling + env var default (default: 'github')
 *   clientSecret: string,            // OAuth client secret (required, or use env var)
 *   clientSecretEnvVar: string,      // Env var for client secret (default: '<PROVIDER>_CLIENT_SECRET')
 * }
 */
export class ElicitationSecretFeature extends Feature {
  constructor(name, config) {
    super(name, config);

    this.secretName = config.secretName || 'elicitation-oauth';
    this.provider = (config.provider || 'github').toLowerCase();

    const clientSecretEnvVar =
      config.clientSecretEnvVar || `${this.provider.toUpperCase()}_CLIENT_SECRET`;
    this.clientSecret = config.clientSecret || process.env[clientSecretEnvVar] || '';
  }

  getFeaturePath() {
    return 'elicitation-secret';
  }

  validate() {
    if (!this.clientSecret) {
      throw new Error(
        `Elicitation secret requires clientSecret or ${this.provider.toUpperCase()}_CLIENT_SECRET env var`
      );
    }
    return true;
  }

  async deploy() {
    this.log(
      `Creating elicitation secret '${this.secretName}' for provider '${this.provider}'...`,
      'info'
    );

    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: this.secretName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
          'agentgateway.dev/provider': this.provider,
        },
      },
      type: 'Opaque',
      stringData: {
        client_secret: this.clientSecret,
      },
    };

    await this.applyResource(secret);
    this.log(`Elicitation secret '${this.secretName}' created`, 'success');
  }

  async cleanup() {
    this.log('Cleaning up elicitation secret...', 'info');
    await this.deleteResource('Secret', this.secretName);
    this.log('Elicitation secret cleaned up', 'success');
  }
}

/**
 * Feature Registry
 *
 * Central registry for all agentgateway features.
 * Import this module to automatically register all available features.
 *
 * Note: Profile-based addons (like telemetry) are registered separately
 * in addons/index.js
 */

import { FeatureManager, PolicyRegistry } from '../src/lib/feature.js';
import { GatewayFeature } from './gateway/index.js';
import { ProvidersFeature } from './providers/index.js';
import { PromptEnrichmentFeature } from './prompt-enrichment/index.js';
import { PromptGuardsFeature } from './prompt-guards/index.js';
import { GuardrailWebhookFeature } from './guardrail-webhook/index.js';
import { ModelFailoverFeature } from './model-failover/index.js';
import { FunctionCallingFeature } from './function-calling/index.js';
import { RateLimitFeature } from './rate-limit/index.js';
import { TokenExchangeFeature } from './token-exchange/index.js';
import { OboTokenExchangeFeature } from './obo-token-exchange/index.js';
import { OAuthAuthorizationCodeFeature } from './oauth-authorization-code/index.js';
import { OAuthAccessTokenValidationFeature } from './oauth-access-token-validation/index.js';
import { AgentFeature } from './agent/index.js';
import { ApiKeyAuthFeature } from './apikey-auth/index.js';
import { McpServerFeature } from './mcp-server/index.js';
import { McpAuthFeature } from './mcp-auth/index.js';
import { McpToolAccessFeature } from './mcp-tool-access/index.js';
import { McpEnterpriseFeature } from './mcp-enterprise/index.js';
import { McpGuardrailsFeature } from './mcp-guardrails/index.js';
import { WorkloadAgentFeature } from './workload-agent/index.js';
import { QuotaBudgetFeature } from './quota-budget/index.js';
import { QuotaRateLimitFeature } from './quota-ratelimit/index.js';
import { ElicitationSecretFeature } from './elicitation-secret/index.js';
import { ElicitationBackendFeature } from './elicitation-backend/index.js';
import { SidecarAgentFeature } from './sidecar-agent/index.js';
import { MultiOrgJwtAuthFeature } from './multi-org-jwt-auth/index.js';
import { OktaJwtAuthFeature } from './okta-jwt-auth/index.js';
import { EntraJwtAuthFeature } from './entra-jwt-auth/index.js';
import { KeycloakJwtAuthFeature } from './keycloak-jwt-auth/index.js';
import { CorporateProxyFeature } from './corporate-proxy/index.js';
import { CertificateFeature } from './certificate/index.js';
import { FrontendMtlsFeature } from './frontend-mtls/index.js';
import { ModelAliasingFeature } from './model-aliasing/index.js';
import { LoadBalancingFeature } from './load-balancing/index.js';
import { PromptTemplatesFeature } from './prompt-templates/index.js';
import { RequestTransformationFeature } from './request-transformation/index.js';
import { CelBasedRbacFeature } from './cel-based-rbac/index.js';
import { VirtualKeysFeature } from './virtual-keys/index.js';
import { LlmCostTrackingFeature } from './llm-cost-tracking/index.js';
import { AgentgatewayModelFeature } from './agentgateway-model/index.js';
import { OpenfgaAuthzFeature } from './openfga-authz/index.js';
import { OpaAuthzFeature } from './opa-authz/index.js';
import { ModelCostsFeature } from './model-costs/index.js';
import { BudgetLimitsFeature } from './budget-limits/index.js';
import { DirectResponseFeature } from './direct-response/index.js';
import { MockProviderFeature } from './mock-provider/index.js';
import { SniMatchingFeature } from './sni-matching/index.js';
import { WafFeature } from './waf/index.js';
import { McpEagerAuthOktaFeature } from './mcp-eager-auth-okta/index.js';
import { McpEagerAuthAuth0Feature } from './mcp-eager-auth-auth0/index.js';
import { McpEagerAuthEntraFeature } from './mcp-eager-auth-entra/index.js';
import { SemanticRouterFeature } from './semantic-router/index.js';
import { OauthTokenExchangeFeature } from './oauth-token-exchange/index.js';
import { TrafficPolicyFeature } from './traffic-policy/index.js';
import { HttpbinBackendFeature } from './httpbin-backend/index.js';
import { OauthIssuerRouteFeature } from './oauth-issuer-route/index.js';
import { AuthOnlyMcpFeature } from './auth-only-mcp/index.js';
import { PostgresFeature } from './postgres/index.js';

// Register all features
FeatureManager.register('gateway', GatewayFeature);
FeatureManager.register('providers', ProvidersFeature);
FeatureManager.register('prompt-enrichment', PromptEnrichmentFeature);
FeatureManager.register('prompt-guards', PromptGuardsFeature);
FeatureManager.register('guardrail-webhook', GuardrailWebhookFeature);
FeatureManager.register('model-failover', ModelFailoverFeature);
FeatureManager.register('function-calling', FunctionCallingFeature);
FeatureManager.register('rate-limit', RateLimitFeature);
FeatureManager.register('token-exchange', TokenExchangeFeature);
FeatureManager.register('obo-token-exchange', OboTokenExchangeFeature);
FeatureManager.register('oauth-authorization-code', OAuthAuthorizationCodeFeature);
FeatureManager.register('oauth-access-token-validation', OAuthAccessTokenValidationFeature);
FeatureManager.register('agent', AgentFeature);
FeatureManager.register('apikey-auth', ApiKeyAuthFeature);
FeatureManager.register('mcp-server', McpServerFeature);
FeatureManager.register('mcp-enterprise', McpEnterpriseFeature);
FeatureManager.register('mcp-guardrails', McpGuardrailsFeature);
FeatureManager.register('mcp-auth', McpAuthFeature);
FeatureManager.register('mcp-tool-access', McpToolAccessFeature);
FeatureManager.register('workload-agent', WorkloadAgentFeature);
FeatureManager.register('quota-budget', QuotaBudgetFeature);
FeatureManager.register('quota-ratelimit', QuotaRateLimitFeature);
FeatureManager.register('elicitation-secret', ElicitationSecretFeature);
FeatureManager.register('elicitation-backend', ElicitationBackendFeature);
FeatureManager.register('sidecar-agent', SidecarAgentFeature);
FeatureManager.register('multi-org-jwt-auth', MultiOrgJwtAuthFeature);
FeatureManager.register('okta-jwt-auth', OktaJwtAuthFeature);
FeatureManager.register('entra-jwt-auth', EntraJwtAuthFeature);
FeatureManager.register('keycloak-jwt-auth', KeycloakJwtAuthFeature);
FeatureManager.register('corporate-proxy', CorporateProxyFeature);
FeatureManager.register('certificate', CertificateFeature);
FeatureManager.register('frontend-mtls', FrontendMtlsFeature);
FeatureManager.register('model-aliasing', ModelAliasingFeature);
FeatureManager.register('load-balancing', LoadBalancingFeature);
FeatureManager.register('prompt-templates', PromptTemplatesFeature);
FeatureManager.register('request-transformation', RequestTransformationFeature);
FeatureManager.register('cel-based-rbac', CelBasedRbacFeature);
FeatureManager.register('virtual-keys', VirtualKeysFeature);
FeatureManager.register('openfga-authz', OpenfgaAuthzFeature);
FeatureManager.register('opa-authz', OpaAuthzFeature);
FeatureManager.register('model-costs', ModelCostsFeature);
FeatureManager.register('budget-limits', BudgetLimitsFeature);
FeatureManager.register('llm-cost-tracking', LlmCostTrackingFeature);
FeatureManager.register('agentgateway-model', AgentgatewayModelFeature);
FeatureManager.register('direct-response', DirectResponseFeature);
FeatureManager.register('mock-provider', MockProviderFeature);
FeatureManager.register('sni-matching', SniMatchingFeature);
FeatureManager.register('waf', WafFeature);
FeatureManager.register('mcp-eager-auth-okta', McpEagerAuthOktaFeature);
FeatureManager.register('mcp-eager-auth-auth0', McpEagerAuthAuth0Feature);
FeatureManager.register('mcp-eager-auth-entra', McpEagerAuthEntraFeature);
FeatureManager.register('semantic-router', SemanticRouterFeature);
FeatureManager.register('oauth-token-exchange', OauthTokenExchangeFeature);
FeatureManager.register('traffic-policy', TrafficPolicyFeature);
FeatureManager.register('httpbin-backend', HttpbinBackendFeature);
FeatureManager.register('postgres', PostgresFeature);
FeatureManager.register('oauth-issuer-route', OauthIssuerRouteFeature);
FeatureManager.register('auth-only-mcp', AuthOnlyMcpFeature);

// Export the FeatureManager and PolicyRegistry for use in other modules
export { FeatureManager, PolicyRegistry };

// Export individual feature classes
export {
  GatewayFeature,
  ProvidersFeature,
  PromptEnrichmentFeature,
  PromptGuardsFeature,
  GuardrailWebhookFeature,
  ModelFailoverFeature,
  FunctionCallingFeature,
  RateLimitFeature,
  TokenExchangeFeature,
  OboTokenExchangeFeature,
  OAuthAuthorizationCodeFeature,
  OAuthAccessTokenValidationFeature,
  AgentFeature,
  ApiKeyAuthFeature,
  McpServerFeature,
  McpAuthFeature,
  McpToolAccessFeature,
  WorkloadAgentFeature,
  QuotaBudgetFeature,
  QuotaRateLimitFeature,
  ElicitationSecretFeature,
  ElicitationBackendFeature,
  SidecarAgentFeature,
  MultiOrgJwtAuthFeature,
  OktaJwtAuthFeature,
  EntraJwtAuthFeature,
  KeycloakJwtAuthFeature,
  CorporateProxyFeature,
  CertificateFeature,
  FrontendMtlsFeature,
  ModelAliasingFeature,
  LoadBalancingFeature,
  PromptTemplatesFeature,
  RequestTransformationFeature,
  OpenfgaAuthzFeature,
  OpaAuthzFeature,
  ModelCostsFeature,
  BudgetLimitsFeature,
  CelBasedRbacFeature,
  VirtualKeysFeature,
  LlmCostTrackingFeature,
  AgentgatewayModelFeature,
  DirectResponseFeature,
  MockProviderFeature,
  TrafficPolicyFeature,
  SniMatchingFeature,
  WafFeature,
  McpEagerAuthOktaFeature,
  McpEagerAuthAuth0Feature,
  McpEagerAuthEntraFeature,
  SemanticRouterFeature,
  OauthTokenExchangeFeature,
  HttpbinBackendFeature,
  OauthIssuerRouteFeature,
  AuthOnlyMcpFeature,
};

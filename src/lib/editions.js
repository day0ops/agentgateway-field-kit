export const EDITIONS = ['enterprise', 'opensource'];

export const DEFAULT_EDITION = 'enterprise';

export function resolveEdition(value) {
  return value === 'opensource' ? 'opensource' : DEFAULT_EDITION;
}

export const EDITION_BASE_NAME = {
  enterprise: 'enterprise-agentgateway',
  opensource: 'agentgateway',
};

// Default Helm release name for the main chart, per edition. This must differ from
// EDITION_BASE_NAME.opensource ("agentgateway"): that string is also the name this repo
// always gives the default Gateway object (config/gateway/default-gateway.yaml), and the
// Gateway API controller auto-provisions a proxy Deployment/Service named after the
// Gateway. If the release name is also literally "agentgateway", the OSS chart's
// controller Deployment/Service (which the chart's fullname template defaults to the
// release name) collides with that proxy Deployment/Service - confirmed by an actual
// install attempt failing with "spec.selector: field is immutable". A release name that
// merely *contains* "agentgateway" (e.g. "agentgateway-oss") avoids the collision: the
// chart's fullname template uses the release name directly whenever it contains the
// chart name, so no separate fullnameOverride is needed.
export const EDITION_RELEASE_NAME = {
  enterprise: 'enterprise-agentgateway',
  opensource: 'agentgateway-oss',
};

export const EDITION_OCI_REGISTRY = {
  enterprise: 'oci://us-docker.pkg.dev/solo-public/enterprise-agentgateway/charts',
  opensource: 'oci://cr.agentgateway.dev/charts',
};

// CRD group/kind used by per-edition policy and parameters resources emitted by
// dual-edition features (e.g. mcp-auth, cel-based-rbac, sidecar-agent).
export const POLICY_API_GROUP = {
  enterprise: 'enterpriseagentgateway.solo.io',
  opensource: 'agentgateway.dev',
};

export const POLICY_KIND = {
  enterprise: 'EnterpriseAgentgatewayPolicy',
  opensource: 'AgentgatewayPolicy',
};

// CRD group/kind for backend resources emitted by dual-edition features (e.g. mock-provider).
// Both kinds support policies.ai.provider.openai and policies.auth.passthrough per the CRD
// schema - verified on enterprise; the opensource path hasn't been runtime-tested against an
// actual opensource-edition cluster in this repo, only confirmed against the CRD schema.
export const BACKEND_API_GROUP = {
  enterprise: 'enterpriseagentgateway.solo.io',
  opensource: 'agentgateway.dev',
};

export const BACKEND_KIND = {
  enterprise: 'EnterpriseAgentgatewayBackend',
  opensource: 'AgentgatewayBackend',
};

export const PARAMETERS_KIND = {
  enterprise: 'EnterpriseAgentgatewayParameters',
  opensource: 'AgentgatewayParameters',
};

export function policyApiVersion(edition) {
  return `${POLICY_API_GROUP[edition]}/v1alpha1`;
}

// GatewayClass.spec.controllerName reconciled by each edition's controller. The
// opensource value is the OSS chart's built-in default (controllerName/gatewayClassName
// left unset in the profile - see config/profiles/eks-opensource-agentgateway.yaml).
export const CONTROLLER_NAME = {
  enterprise: 'solo.io/enterprise-agentgateway',
  opensource: 'agentgateway.dev/agentgateway',
};

// Default name for the Gateway object installProxy() creates (config/gateway/
// default-gateway.yaml) and that HTTPRoutes reference via parentRefs
// (FeatureManager.getGatewayRef()). The Gateway API controller auto-provisions a proxy
// Deployment/Service named after the Gateway, so each edition's value stays visibly
// distinct from that edition's own chart/release name (EDITION_BASE_NAME /
// EDITION_RELEASE_NAME) to avoid any naming collision with the controller's resources.
export const EDITION_GATEWAY_NAME = {
  enterprise: 'agentgateway-gw',
  opensource: 'agentgateway-oss-gw',
};

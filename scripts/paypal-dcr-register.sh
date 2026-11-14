#!/usr/bin/env bash
set -euo pipefail

# Registers a PayPal sandbox MCP OAuth client via Dynamic Client Registration
# (RFC 7591) and prints the resulting credentials as env var exports.
#
# The demo-wizard usecase's Interactive elicitation step
# (config/usecases/enterprise/demo-wizard/agentgateway-demo-wizard.yaml)
# reads AGW_DEMO_PAYPAL_CLIENT_ID / AGW_DEMO_PAYPAL_CLIENT_SECRET at deploy
# time. Nothing in the deploy pipeline performs this registration - PayPal's
# MCP OAuth server (mcp.sandbox.paypal.com) only supports DCR, not
# dashboard-issued credentials, so this has to be run by hand. Re-run it
# whenever the redirect_uri changes (e.g. the agentgatewayUi domain changes)
# or the previous registration is lost, then export the printed values
# before `agw usecase deploy`.
#
# Usage:
#   scripts/paypal-dcr-register.sh --redirect-uri https://agw-ui.example.com/elicitations
#   scripts/paypal-dcr-register.sh --redirect-uri <uri> --issuer https://mcp.sandbox.paypal.com

ISSUER="https://mcp.sandbox.paypal.com"
REDIRECT_URI=""

print_usage() {
  echo "Usage: $0 --redirect-uri <https://.../elicitations>" >&2
  echo "Options:" >&2
  echo "  --redirect-uri <uri>  Required. Must exactly match the gateway policy's redirectUri." >&2
  echo "  --issuer <url>        Defaults to ${ISSUER}." >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --redirect-uri)
      REDIRECT_URI="$2"
      shift 2
      ;;
    --issuer)
      ISSUER="$2"
      shift 2
      ;;
    --help)
      print_usage
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      print_usage
      exit 1
      ;;
  esac
done

if [[ -z "$REDIRECT_URI" ]]; then
  print_usage
  exit 1
fi

REGISTRATION_ENDPOINT="${ISSUER}/register"

RESPONSE=$(curl -s -w '\n%{http_code}' -X POST "$REGISTRATION_ENDPOINT" \
  -H 'Content-Type: application/json' \
  -d "$(
    jq -n --arg redirect_uri "$REDIRECT_URI" '{
      client_name: "agentgateway-demo-wizard (PayPal interactive elicitation)",
      redirect_uris: [$redirect_uri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post"
    }'
  )")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" -lt 200 || "$HTTP_CODE" -ge 300 ]]; then
  echo "Registration failed (${HTTP_CODE}):" >&2
  echo "$BODY" | jq . >&2 2>/dev/null || echo "$BODY" >&2
  exit 1
fi

REGISTRATION_ACCESS_TOKEN=$(echo "$BODY" | jq -r '.registration_access_token // empty')
if [[ -n "$REGISTRATION_ACCESS_TOKEN" ]]; then
  echo "# registration_access_token - save separately if you ever want to inspect/update this" >&2
  echo "# client via RFC 7592; nothing here persists or reuses it:" >&2
  echo "# ${REGISTRATION_ACCESS_TOKEN}" >&2
  echo "# registration_client_uri: $(echo "$BODY" | jq -r '.registration_client_uri // empty')" >&2
  echo "" >&2
fi

echo "export AGW_DEMO_PAYPAL_CLIENT_ID=$(echo "$BODY" | jq -r '.client_id')"
echo "export AGW_DEMO_PAYPAL_CLIENT_SECRET=$(echo "$BODY" | jq -r '.client_secret')"

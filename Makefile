.PHONY: help install install-local install-infra install-interactive start stop status clean clean-usecases clean-addons clean-local-infra test lint format deploy-usecase dryrun-usecase test-usecase list-profiles list-usecases list-features \
	build-extras build-stock-server-mcp build-currency-server-mcp build-random-server-mcp build-guardrail-webhook build-stock-agent build-caller-agent build-sidecar-agent build-quota-management build-quota-budget-extproc build-quota-ratelimit-extproc \
	container-multiarch-push \
	push-extras push-stock-server-mcp push-currency-server-mcp push-random-server-mcp push-guardrail-webhook push-stock-agent push-caller-agent push-sidecar-agent push-quota-management push-quota-budget-extproc push-quota-ratelimit-extproc \
	deploy-stock-server-mcp deploy-currency-server-mcp deploy-random-server-mcp deploy-guardrail-webhook deploy-stock-agent deploy-caller-agent deploy-sidecar-agent deploy-quota-management \
	undeploy-stock-server-mcp undeploy-currency-server-mcp undeploy-random-server-mcp undeploy-guardrail-webhook undeploy-stock-agent undeploy-caller-agent undeploy-sidecar-agent undeploy-quota-management
.DEFAULT_GOAL := help

BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[1;33m
NC := \033[0m

CLI_VERSION := $(shell bun src/cli.js version --short 2>/dev/null | head -1)
CLI_DESCRIPTION := $(shell bun src/cli.js version --short 2>/dev/null | sed -n '2p')

##@ General

help: ## Display this help message
	@echo "$(BLUE)Agentgateway Field Kit v$(CLI_VERSION)$(NC)"
	@echo "$(BLUE)$(CLI_DESCRIPTION)$(NC)"
	@echo ""
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make $(GREEN)<target>$(NC)\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  $(GREEN)%-15s$(NC) %s\n", $$1, $$2 } /^##@/ { printf "\n$(BLUE)%s$(NC)\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

version: ## Show version information (banner, version, description)
	@bun src/cli.js version

##@ Setup

install-infra: ## Install infrastructure (lok8s cluster)
	@bun src/cli.js base infra local install

install: ## Install agentgateway
	@bun src/cli.js base install

install-local: ## Install everything (minimal profile)
	@echo "$(BLUE)Installing complete stack with minimal profile...$(NC)"
	@bun src/cli.js base install-local --profile minimal --no-prompt

install-interactive: ## Install everything (interactive)
	@echo "$(BLUE)Installing complete stack...$(NC)"
	@bun run setup

start: ## Start lok8s cluster
	@echo "$(BLUE)Starting lok8s cluster...$(NC)"
	@bun src/cli.js base infra local start

stop: ## Stop lok8s cluster
	@echo "$(BLUE)Stopping lok8s cluster...$(NC)"
	@bun src/cli.js base infra local stop

status: ## Show infrastructure status
	@bun src/cli.js base infra local status

##@ Profiles

list-profiles: ## List available installation profiles
	@bun src/cli.js profile list

##@ Use Cases

list-usecases:
	@bun src/cli.js usecase list

deploy-usecase: ## Deploy a use case (USECASE=name)
	@if [ -z "$(USECASE)" ]; then \
		HIDE_DIAGRAMS=$(HIDE_DIAGRAMS) bun src/cli.js usecase deploy; \
	else \
		HIDE_DIAGRAMS=$(HIDE_DIAGRAMS) bun src/cli.js usecase deploy --name $(USECASE); \
	fi

dryrun-usecase: ## Dry-run a use case (USECASE=name)
	@if [ -z "$(USECASE)" ]; then \
		bun src/cli.js usecase dryrun; \
	else \
		bun src/cli.js usecase dryrun --name $(USECASE); \
	fi

test-usecase:
	@if [ -z "$(USECASE)" ]; then \
		bun src/cli.js usecase test; \
	else \
		bun src/cli.js usecase test $(USECASE); \
	fi

##@ Features

list-features: ## List available features
	@bun src/cli.js feature list

##@ Development

##@ Testing

test: ## Run all tests
	@echo "$(BLUE)Running tests...$(NC)"
	@bun test

lint:
	@echo "$(BLUE)Linting JavaScript...$(NC)"
	@bun run lint

format:
	@echo "$(BLUE)Formatting code...$(NC)"
	@bun run format

##@ Cleanup

clean-usecases: ## Clean up deployed use cases
	@echo "$(BLUE)Cleaning up deployed use case(s)...$(NC)"
	@bun src/cli.js usecase clean --current --no-prompt

clean-addons: ## Clean up all profile-based addons
	@echo "$(BLUE)Cleaning up all addons...$(NC)"
	@bun src/cli.js base clean -a

clean-local-infra: ## Remove lok8s cluster
	@bun src/cli.js base infra local destroy

clean: ## Clean up usecases, gateway, and addons (preserves cluster)
	@echo "$(BLUE)Cleaning up usecases, gateway, and addons...$(NC)"
	@bun src/cli.js usecase clean --current --no-prompt
	@bun src/cli.js base clean -a
	@echo "$(GREEN)Cleanup completed$(NC)"

##@ Extras

IMAGE_REPO ?=
IMAGE_PREFIX := $(if $(IMAGE_REPO),$(IMAGE_REPO)/,)
IMAGE_TAG ?= latest
VERSION ?= latest
PLATFORMS ?= linux/amd64,linux/arm64
DOCKER ?= docker
PODMAN ?= podman
PODMAN_MANIFEST_PUSH_FLAGS ?=
PODMAN_INSECURE_REGISTRY ?=
DOCKER_BUILD_FLAGS ?=
CONTAINER_MULTIARCH_DOCKERFILE ?=

PODMAN_TLS_OPTS := $(if $(filter true 1,$(PODMAN_INSECURE_REGISTRY)),--tls-verify=false,)

container-multiarch-push: ## Push multi-arch image (set CONTAINER_MULTIARCH_IMAGE and CONTAINER_MULTIARCH_CONTEXT)
	@set -e; \
	test -n "$(CONTAINER_MULTIARCH_IMAGE)" && test -n "$(CONTAINER_MULTIARCH_CONTEXT)"; \
	if $(DOCKER) version 2>/dev/null | grep -qi podman; then \
		$(PODMAN) manifest rm $(CONTAINER_MULTIARCH_IMAGE) 2>/dev/null || true; \
		$(PODMAN) manifest create $(CONTAINER_MULTIARCH_IMAGE); \
		for platform in $$(echo "$(PLATFORMS)" | tr ',' ' '); do \
			pf=$$(echo "$$platform" | tr '/' '-'); \
			( cd "$(CONTAINER_MULTIARCH_CONTEXT)" && $(PODMAN) build $(PODMAN_TLS_OPTS) $(DOCKER_BUILD_FLAGS) $(CONTAINER_MULTIARCH_DOCKERFILE:%=-f %) \
				--platform "$$platform" \
				-t $(CONTAINER_MULTIARCH_IMAGE).work-$$pf . ); \
			$(PODMAN) manifest add $(PODMAN_TLS_OPTS) $(CONTAINER_MULTIARCH_IMAGE) $(CONTAINER_MULTIARCH_IMAGE).work-$$pf; \
		done; \
		$(PODMAN) manifest push $(PODMAN_TLS_OPTS) $(PODMAN_MANIFEST_PUSH_FLAGS) $(CONTAINER_MULTIARCH_IMAGE) docker://$(CONTAINER_MULTIARCH_IMAGE); \
	else \
		( cd "$(CONTAINER_MULTIARCH_CONTEXT)" && $(DOCKER) buildx build $(DOCKER_BUILD_FLAGS) $(CONTAINER_MULTIARCH_DOCKERFILE:%=-f %) \
			--platform $(PLATFORMS) --push -t $(CONTAINER_MULTIARCH_IMAGE) . ); \
	fi

BUILDX_BUILDER ?= agw-builder

setup-buildx: ## Setup buildx with insecure registry (requires REGISTRY_IP env var)
	@if [ -z "$(REGISTRY_IP)" ]; then \
		echo "$(YELLOW)REGISTRY_IP not set. Using default buildx.$(NC)"; \
		exit 0; \
	fi; \
	echo "$(BLUE)Setting up buildx for insecure registry at $(REGISTRY_IP)...$(NC)"; \
	printf '[registry."$(REGISTRY_IP):5000"]\n  insecure = true\n\n[registry."$(REGISTRY_IP):5001"]\n  insecure = true\n' > /tmp/buildkitd.toml; \
	docker buildx rm $(BUILDX_BUILDER) 2>/dev/null || true; \
	docker buildx create --name $(BUILDX_BUILDER) \
		--driver docker-container \
		--config /tmp/buildkitd.toml \
		--use; \
	docker buildx inspect --bootstrap; \
	echo "$(GREEN)Buildx builder '$(BUILDX_BUILDER)' ready with insecure registry at $(REGISTRY_IP)$(NC)"; \
	echo "$(YELLOW)If pods fail to pull with x509: unknown authority, configure each cluster node’s containerd for $(REGISTRY_IP):5000 (TLS skip_verify or plain HTTP endpoint). See containerd hosts.md.$(NC)"

clean-buildx: ## Remove the lok8s buildx builder
	@docker buildx rm $(BUILDX_BUILDER) 2>/dev/null || true
	@echo "$(GREEN)Buildx builder '$(BUILDX_BUILDER)' removed$(NC)"

build-extras: ## Build all extras images
	@echo "$(BLUE)Building all extras...$(NC)"
	@$(MAKE) -C extras/stock-server-mcp build
	@$(MAKE) -C extras/currency-server-mcp build
	@$(MAKE) -C extras/random-server-mcp build
	@$(MAKE) -C extras/guardrail-webhook build
	@$(MAKE) -C extras/stock-agent build
	@$(MAKE) -C extras/caller-agent build
	@$(MAKE) -C extras/sidecar-agent build
	@$(MAKE) build-quota-management

build-stock-server-mcp: ## Build the stock MCP server image
	@$(MAKE) -C extras/stock-server-mcp build

build-currency-server-mcp: ## Build the currency MCP server image
	@$(MAKE) -C extras/currency-server-mcp build

build-random-server-mcp: ## Build the random MCP server image
	@$(MAKE) -C extras/random-server-mcp build

build-guardrail-webhook: ## Build the guardrail webhook image
	@$(MAKE) -C extras/guardrail-webhook build

build-stock-agent: ## Build the stock agent image
	@$(MAKE) -C extras/stock-agent build

build-caller-agent: ## Build the caller agent image
	@$(MAKE) -C extras/caller-agent build

build-sidecar-agent: ## Build the sidecar agent image
	@$(MAKE) -C extras/sidecar-agent build

build-quota-budget-extproc: ## Build the quota-budget ext-proc image
	@$(MAKE) -C extras/quota-management docker-build-extproc-budget

build-quota-ratelimit-extproc: ## Build the quota-ratelimit ext-proc image
	@$(MAKE) -C extras/quota-management docker-build-extproc-ratelimit

build-quota-management: build-quota-budget-extproc build-quota-ratelimit-extproc ## Build all quota management images

push-extras: ## Push all extras images (multi-arch)
	@echo "$(BLUE)Pushing all extras...$(NC)"
	@$(MAKE) push-stock-server-mcp
	@$(MAKE) push-currency-server-mcp
	@$(MAKE) push-random-server-mcp
	@$(MAKE) push-guardrail-webhook
	@$(MAKE) push-stock-agent
	@$(MAKE) push-caller-agent
	@$(MAKE) push-sidecar-agent
	@$(MAKE) push-quota-management

push-stock-server-mcp: ## Push the stock MCP server image (multi-arch)
	@$(MAKE) container-multiarch-push \
		CONTAINER_MULTIARCH_IMAGE=$(IMAGE_PREFIX)stock-server-mcp:$(IMAGE_TAG) \
		CONTAINER_MULTIARCH_CONTEXT=extras/stock-server-mcp/server

push-currency-server-mcp: ## Push the currency MCP server image (multi-arch)
	@$(MAKE) container-multiarch-push \
		CONTAINER_MULTIARCH_IMAGE=$(IMAGE_PREFIX)currency-server-mcp:$(IMAGE_TAG) \
		CONTAINER_MULTIARCH_CONTEXT=extras/currency-server-mcp/server

push-random-server-mcp: ## Push the random MCP server image (multi-arch)
	@$(MAKE) container-multiarch-push \
		CONTAINER_MULTIARCH_IMAGE=$(IMAGE_PREFIX)random-server-mcp:$(IMAGE_TAG) \
		CONTAINER_MULTIARCH_CONTEXT=extras/random-server-mcp/server

push-guardrail-webhook: ## Push the guardrail webhook image (multi-arch)
	@$(MAKE) container-multiarch-push \
		CONTAINER_MULTIARCH_IMAGE=$(IMAGE_PREFIX)opik-guardrail-webhook:$(IMAGE_TAG) \
		CONTAINER_MULTIARCH_CONTEXT=extras/guardrail-webhook/server

push-stock-agent: ## Push the stock agent image (multi-arch)
	@$(MAKE) container-multiarch-push \
		CONTAINER_MULTIARCH_IMAGE=$(IMAGE_PREFIX)stock-agent:$(IMAGE_TAG) \
		CONTAINER_MULTIARCH_CONTEXT=extras/stock-agent/server

push-caller-agent: ## Push the caller agent image (multi-arch)
	@$(MAKE) container-multiarch-push \
		CONTAINER_MULTIARCH_IMAGE=$(IMAGE_PREFIX)caller-agent:$(IMAGE_TAG) \
		CONTAINER_MULTIARCH_CONTEXT=extras/caller-agent/server

push-sidecar-agent: ## Push the sidecar agent image (multi-arch)
	@$(MAKE) container-multiarch-push \
		CONTAINER_MULTIARCH_IMAGE=$(IMAGE_PREFIX)sidecar-agent:$(IMAGE_TAG) \
		CONTAINER_MULTIARCH_CONTEXT=extras/sidecar-agent/server

push-quota-budget-extproc: ## Push the quota-budget ext-proc image (multi-arch)
	@$(MAKE) container-multiarch-push \
		CONTAINER_MULTIARCH_IMAGE=$(IMAGE_PREFIX)quota-budget-extproc:$(IMAGE_TAG) \
		CONTAINER_MULTIARCH_CONTEXT=extras/quota-management \
		CONTAINER_MULTIARCH_DOCKERFILE=Dockerfile.extproc-budget

push-quota-ratelimit-extproc: ## Push the quota-ratelimit ext-proc image (multi-arch)
	@$(MAKE) container-multiarch-push \
		CONTAINER_MULTIARCH_IMAGE=$(IMAGE_PREFIX)quota-ratelimit-extproc:$(IMAGE_TAG) \
		CONTAINER_MULTIARCH_CONTEXT=extras/quota-management \
		CONTAINER_MULTIARCH_DOCKERFILE=Dockerfile.extproc-ratelimit

push-quota-management: push-quota-budget-extproc push-quota-ratelimit-extproc ## Push all quota management images (multi-arch)
	@$(MAKE) container-multiarch-push \
		CONTAINER_MULTIARCH_IMAGE=$(IMAGE_PREFIX)quota-management-ui:$(IMAGE_TAG) \
		CONTAINER_MULTIARCH_CONTEXT=extras/quota-management \
		CONTAINER_MULTIARCH_DOCKERFILE=Dockerfile.ui

deploy-stock-server-mcp: ## Deploy the stock MCP server to K8s
	@$(MAKE) -C extras/stock-server-mcp deploy

deploy-currency-server-mcp: ## Deploy the currency MCP server to K8s
	@$(MAKE) -C extras/currency-server-mcp deploy

deploy-random-server-mcp: ## Deploy the random MCP server to K8s
	@$(MAKE) -C extras/random-server-mcp deploy

deploy-guardrail-webhook: ## Deploy the guardrail webhook to K8s
	@$(MAKE) -C extras/guardrail-webhook deploy

deploy-stock-agent: ## Deploy the stock agent to K8s
	@$(MAKE) -C extras/stock-agent deploy

deploy-caller-agent: ## Deploy the caller agent to K8s
	@$(MAKE) -C extras/caller-agent deploy

deploy-sidecar-agent: ## Deploy the sidecar agent to K8s
	@$(MAKE) -C extras/sidecar-agent deploy

deploy-quota-management: ## Deploy the quota management to K8s
	@$(MAKE) -C extras/quota-management deploy

undeploy-stock-server-mcp: ## Remove the stock MCP server from K8s
	@$(MAKE) -C extras/stock-server-mcp undeploy

undeploy-currency-server-mcp: ## Remove the currency MCP server from K8s
	@$(MAKE) -C extras/currency-server-mcp undeploy

undeploy-random-server-mcp: ## Remove the random MCP server from K8s
	@$(MAKE) -C extras/random-server-mcp undeploy

undeploy-guardrail-webhook: ## Remove the guardrail webhook from K8s
	@$(MAKE) -C extras/guardrail-webhook undeploy

undeploy-stock-agent: ## Remove the stock agent from K8s
	@$(MAKE) -C extras/stock-agent undeploy

undeploy-caller-agent: ## Remove the caller agent from K8s
	@$(MAKE) -C extras/caller-agent undeploy

undeploy-sidecar-agent: ## Remove the sidecar agent from K8s
	@$(MAKE) -C extras/sidecar-agent undeploy

undeploy-quota-management: ## Remove the quota management from K8s
	@$(MAKE) -C extras/quota-management undeploy

##@ Utilities

check-deps:
	@bun src/cli.js check-deps

env-example:
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo "$(GREEN)Created .env file. Please edit it with your API keys.$(NC)"; \
	else \
		echo "$(YELLOW).env file already exists$(NC)"; \
	fi

load-env:
	@if [ -f .env ]; then \
		export $$(cat .env | grep -v '^#' | xargs); \
		echo "$(GREEN)Environment variables loaded$(NC)"; \
	else \
		echo "$(YELLOW).env file not found. Run 'make env-example' first.$(NC)"; \
	fi


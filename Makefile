OUTPUT ?= godesk
FRONTEND_DIR ?= frontend
BACKEND_DIR := backend
WEB_DIST := $(CURDIR)/$(BACKEND_DIR)/internal/webui/dist
OUTPUT_PATH = $(if $(filter /%,$(firstword $(OUTPUT))),$(OUTPUT),$(CURDIR)/$(OUTPUT))

VERSION ?= dev
COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || true)
BUILD_DATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
GO_LDFLAGS := -s -w -X godesk/internal/buildinfo.Version=$(VERSION) -X godesk/internal/buildinfo.Commit=$(COMMIT) -X godesk/internal/buildinfo.Date=$(BUILD_DATE)

.PHONY: build build-backend dev help
build: ## 构建带 gzip 前端资源的发布二进制
	pnpm --dir "$(FRONTEND_DIR)" run build --outDir "$(WEB_DIST)" --emptyOutDir
	node "$(BACKEND_DIR)/internal/webui/pack.mjs" "$(WEB_DIST)"
	CGO_ENABLED=0 go -C "$(BACKEND_DIR)" build -tags web -trimpath -ldflags="$(GO_LDFLAGS)" -o "$(OUTPUT_PATH)" ./cmd/godesk

build-backend: ## 构建纯 Go 后端
	CGO_ENABLED=0 go -C "$(BACKEND_DIR)" build -trimpath -ldflags="$(GO_LDFLAGS)" -o "$(OUTPUT_PATH)" ./cmd/godesk

dev: ## 同时启动 Vite 前端和 Go 后端
	@node scripts/dev.mjs "$(FRONTEND_DIR)"

help: ## 列出可用命令及说明
	@awk -F ':.*## ' '/^[[:alnum:]_-]+:.*## / { printf "  make %-16s %s\n", $$1, $$2 }' "$(firstword $(MAKEFILE_LIST))"

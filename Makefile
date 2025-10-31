# Simple Makefile for running local server and Cloudflare Tunnel without config files

.PHONY: run cf-quick cf-login cf-named-start cf-named-dns stop

PORT?=8787
HOSTNAME?=tm-ct.nemume.dev
TUNNEL_NAME?=tm-ct


run:
	@echo "Starting Node server on :$(PORT) ..."
	nohup node server.mjs >/dev/null 2>&1 & echo $$! > .server.pid
	@echo "Starting Cloudflare Tunnel ..."
	@if [ -n "$$CLOUDFLARE_TUNNEL_TOKEN" ]; then \
		echo "Using named tunnel token"; \
		cloudflared tunnel --no-autoupdate --config cloudflared/config.yml run --token $$CLOUDFLARE_TUNNEL_TOKEN; \
	elif [ -n "$(TUNNEL_NAME)" ] && [ -f "$$HOME/.cloudflared/cert.pem" ]; then \
		echo "Using named tunnel $(TUNNEL_NAME) with local cert"; \
		cloudflared tunnel --no-autoupdate --config cloudflared/config.yml run $(TUNNEL_NAME); \
	else \
		echo "Using Quick Tunnel to http://localhost:$(PORT) at https://$(HOSTNAME)"; \
		cloudflared tunnel --no-autoupdate --url http://localhost:$(PORT) --hostname $(HOSTNAME); \
	fi

# Quick Tunnel (ephemeral URL) mapping to localhost:$(PORT)
cf-quick:
	cloudflared tunnel --url http://localhost:$(PORT)

# One-time: login and create a named tunnel (no config file)
cf-login:
	cloudflared tunnel login
	cloudflared tunnel create $(TUNNEL_NAME)

# Run named tunnel binding localhost:$(PORT) (no YAML). Requires DNS route set.
cf-named-start:
	cloudflared tunnel run --url http://localhost:$(PORT) $(TUNNEL_NAME)

# Create/Update DNS route for named tunnel
cf-named-dns:
	@if [ -z "$$HOSTNAME" ]; then echo "Usage: make cf-named-dns HOSTNAME=rt.example.com"; exit 1; fi
	cloudflared tunnel route dns $(TUNNEL_NAME) $$HOSTNAME

stop:
	-@[ -f .server.pid ] && kill `cat .server.pid` 2>/dev/null || true; rm -f .server.pid || true
	- pkill -f "cloudflared tunnel" || true



---
tags:
  - type/claude-repo
description: "An MCP server that reads and adds Parcel app deliveries for any MCP client, deployed as a Cloudflare Worker that is its own OAuth authorization server. Cloudflare Access approves grants."
docs_home: "{workspace_root}/System"
---

# parcel-mcp

This repository ships a small MCP server for the Parcel package-tracking app: three tools (connection status, list active deliveries, add a delivery) over Streamable HTTP, deployed as a Cloudflare Worker that issues OAuth tokens after owner consent. Cloudflare Access authenticates the owner only at `/authorize`; `/mcp` accepts Worker-issued bearer tokens. The code is generic and public; the estate's own deployment (hostname, Access application, KV namespace, deploy token) is documented in the paired vault home at `docs_home`, never here.

@AGENTS.md

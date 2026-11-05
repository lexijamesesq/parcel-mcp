---
tags:
  - type/claude-repo
description: "An MCP server that reads and adds Parcel app deliveries for any MCP client, deployed as a Cloudflare Worker behind Cloudflare Access."
docs_home: "{workspace_root}/System"
---

# parcel-mcp

This repository ships a small MCP server for the Parcel package-tracking app: three tools (connection status, list active deliveries, add a delivery) over Streamable HTTP, deployed as a Cloudflare Worker and gated by Cloudflare Access, so ChatGPT, Claude, Grok and headless agents connect through one URL with OAuth or a service token. The code is generic and public; the estate's own deployment (hostname, Access application, KV namespace, deploy token) is documented in the paired vault home at `docs_home`, never here.

@AGENTS.md

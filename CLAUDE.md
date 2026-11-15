---
tags:
  - type/claude-repo
description: "An MCP server that reads and adds Parcel app deliveries for any MCP client, deployed as a Cloudflare Worker that is its own OAuth authorization server. Cloudflare Access approves grants."
linear_project_id: "97f4943a-ec69-4f1c-a33d-0eb6882a5c69"
linear_url: "https://linear.app/lexijamesesq/project/parcel-mcp-99608636fcec"
notion_project: "https://app.notion.com/p/4195f53f7dbc81189ea1d3c34f36bc18"
notion_knowledge: "collection://4195f53f-7dbc-8145-83ab-000b9ee10207"
---

# parcel-mcp

This repository ships a small MCP server for the Parcel package-tracking app: three tools (connection status, list active and recently completed deliveries, add a delivery) over Streamable HTTP, deployed as a Cloudflare Worker that issues OAuth tokens after owner consent. Cloudflare Access authenticates the owner only at `/authorize`; `/mcp` accepts Worker-issued bearer tokens. The code is generic and public; the estate's own deployment (hostname, Access application, KV namespace, deploy token) is documented on the project's private Notion page, which `notion_project` points to, never here.

@AGENTS.md

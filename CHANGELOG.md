# Changelog

## 2.0.0

- Replace `list_active_deliveries` with `list_deliveries`, always using Parcel's recent view to include recently completed deliveries. No filter argument or old-name alias.
- Return explicit status labels alongside status codes and clarify that absence does not establish completion.
- Preserve existing read grants and update consent wording for the recent view. Clients must refresh tool discovery.

## 1.0.1

- Reject unsupported MCP protocol-version headers.
- Bound token and consent form bodies and throttle public requests before OAuth dispatch.
- Redact query strings in observability and sample Worker traces.
- Gate deployment and source releases on the existing tests and typecheck.
- Correct installation, recovery, and best-effort read-throttling documentation.

## 1.0.0

Initial OAuth-enabled Parcel MCP implementation: connection status, active deliveries,
and adding deliveries, with owner consent, scoped grants, and rotating refresh tokens.

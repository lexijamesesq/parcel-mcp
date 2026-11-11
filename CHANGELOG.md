# Changelog

## 1.0.1

- Reject unsupported MCP protocol-version headers.
- Bound token and consent form bodies and throttle public requests before OAuth dispatch.
- Redact query strings in observability and sample Worker traces.
- Gate deployment and source releases on the existing tests and typecheck.
- Correct installation, recovery, and best-effort read-throttling documentation.

## 1.0.0

Initial OAuth-enabled Parcel MCP implementation: connection status, active deliveries,
and adding deliveries, with owner consent, scoped grants, and rotating refresh tokens.

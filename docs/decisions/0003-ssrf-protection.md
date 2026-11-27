# 3. Treat every monitored URL as hostile

**Status:** accepted

## Context

Users choose URLs that the server requests. Without controls they could reach the database, cloud
metadata or other internal services (server-side request forgery).

## Decision

- Allow only `http` and `https` on ports 80, 443, 8080 and 8443, with no credentials in the URL.
- Resolve the name, and refuse it if **any** address is not public. IPv4 uses a block list; IPv6
  allows only global unicast, minus special ranges.
- Connect only to the addresses that passed, which defeats DNS rebinding.
- Never follow redirects. A 2xx or 3xx response counts as up.
- Discard response bodies and apply one deadline to the whole check.

## Consequences

- Services on private networks cannot be monitored.
- A redirect to a broken page still counts as up.
- The address lists need review when new special ranges are assigned.
- Network egress rules remain worthwhile as a second layer.

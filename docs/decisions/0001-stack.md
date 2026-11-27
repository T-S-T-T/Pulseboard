# 1. One repository, TypeScript API and web app, plain SQL

**Status:** accepted

## Context

Phase 1 needs a usable product quickly, with room for Go and Python services later.

## Decision

An npm workspaces repository with a Fastify API and a Next.js web app. The database is accessed with
the `pg` driver and plain SQL migrations. The scheduler runs inside the API process.

## Consequences

- SQL, including security policies, is visible and reviewable.
- Row types are declared by hand, so integration tests must catch mismatches.
- The web app and API share no code yet; API types are repeated in the web app.
- Scheduling and request handling share resources until phase 2 separates them.

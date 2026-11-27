# 2. Enforce tenant isolation with row-level security

**Status:** accepted

## Context

Many teams share the same tables. One forgotten `WHERE team_id = ...` must not expose data.

## Decision

- The API connects as `pulseboard_app`, which owns no objects and cannot bypass RLS.
- Each tenant request runs in a transaction that sets `app.user_id`. Policies check that user's
  membership and role.
- Identity tables have no grants. Sign-in, invites, scheduling and status pages use narrow
  `SECURITY DEFINER` functions.
- The API also checks roles, to return clear 403 and 404 responses.

## Consequences

- Isolation tests query the database directly, without the API's checks.
- New tables must enable RLS and add policies and grants in the same migration.
- **Limit:** RLS protects against mistakes in application queries. It does not protect against a
  fully compromised API or arbitrary SQL injection, because the API chooses `app.user_id` and may
  call the sign-in functions.
- The scheduler shares the API's database role. Separate workers in phase 2 can have their own.

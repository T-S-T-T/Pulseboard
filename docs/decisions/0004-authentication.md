# 4. Server-side sessions, with optional OpenID Connect

**Status:** accepted

## Context

Visitors must be able to sign up without any third-party setup, and teams may want single sign-on.

## Decision

- Passwords are hashed with scrypt (N=2^15, r=8, p=3).
- Sessions are random tokens; the database stores only their SHA-256 hashes. They can be revoked.
- Cookies are `HttpOnly` and `SameSite=Lax`, and `Secure` with the `__Host-` prefix over HTTPS.
- State-changing requests must come from the app's origin and use JSON.
- OpenID Connect uses the authorization code flow with PKCE, state and nonce.
- A provider sign-in is never linked automatically to an existing password account, because email
  addresses are not verified at sign-up.

## Consequences

- Each authenticated request reads the session from the database.
- Someone with a password account cannot add single sign-on to it yet.
- Rate limits are held in memory, so they apply per API instance.

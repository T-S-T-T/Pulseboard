# Pulseboard

[![CI](https://github.com/T-S-T-T/Pulseboard/actions/workflows/ci.yml/badge.svg)](https://github.com/T-S-T-T/Pulseboard/actions/workflows/ci.yml)

Uptime monitoring with team dashboards and public status pages. Add a URL, Pulseboard checks it on
a schedule, and your team and your users can see when it fails.

> **Status: phase 1 of 6.** Features below are built; planned work is in the [Roadmap](#roadmap).
> The project runs locally with Docker. There is no hosted demo.

## Screenshots

**Team dashboard:** current state, recent history and the reason for a failure.

![Team dashboard with one service up and one down](docs/screenshots/dashboard.png)

**Public status page:** service names and uptime only.

![Public status page showing one service up and one down](docs/screenshots/status-page.png)

## Features

- Email and password sign-up, plus optional OpenID Connect single sign-on
- Teams with owner, admin and member roles, and single-use invite links
- HTTP checks every 1 to 60 minutes, with status, latency and recent history
- A public status page per team that never exposes URLs or error details
- OpenAPI documentation at `/api/docs`

## Architecture

```mermaid
flowchart LR
  Browser --> Web["Web app (Next.js)"]
  Web -- /api --> API["API (Fastify)"]
  API --> DB[(PostgreSQL)]
  Scheduler["Scheduler (inside the API)"] --> DB
  Scheduler --> Targets["Monitored services"]
```

| Part | Technology |
| --- | --- |
| Web | Next.js, React, TypeScript, Tailwind CSS |
| API | Node.js, Fastify, Zod, OpenAPI |
| Data | PostgreSQL with row-level security, plain SQL migrations |
| Tests | Vitest, Testcontainers, Playwright |
| Running and CI | Docker Compose, GitHub Actions |

## Security design

- **Tenant isolation** is enforced by PostgreSQL row-level security as well as by the API
  ([decision 2](docs/decisions/0002-row-level-security.md)).
- **SSRF protection:** monitored URLs must resolve only to public addresses, connections are pinned
  to the checked address and redirects are not followed
  ([decision 3](docs/decisions/0003-ssrf-protection.md)).
- **Accounts:** scrypt password hashes, server-side sessions stored as hashes, `HttpOnly`
  `SameSite=Lax` cookies, origin checks and rate limits
  ([decision 4](docs/decisions/0004-authentication.md)).

## Run it

You need [Docker](https://www.docker.com/products/docker-desktop/). For development you also need
Node.js 22.12 or later.

```sh
git clone https://github.com/T-S-T-T/Pulseboard.git
cd Pulseboard
```

### Everything in Docker

```sh
docker compose up --build
```

Open http://localhost:3000, sign up and create a team. Add `https://example.com/` to see a passing
check and `https://does-not-exist.invalid/` to see a failing one. API documentation is at
http://localhost:3000/api/docs.

Press Ctrl+C to stop. `docker compose down` removes the containers and keeps your data;
`docker compose down -v` deletes the data too.

### Development with live reload

```sh
npm ci
cp .env.example .env      # PowerShell: Copy-Item .env.example .env
npm run db:up             # PostgreSQL on port 5433
npm run db:migrate
npm run dev               # web on :3000, API on :4000
```

## Test

```sh
npm run lint
npm run typecheck
npm test                  # starts a temporary PostgreSQL with Testcontainers (needs Docker)
```

End-to-end tests need the database from `npm run db:up`, a `.env` file and a build. Stop
`npm run dev` first.

```sh
npm run build
npm run db:migrate
npx playwright install chromium
npm run test:e2e
```

## Project layout

```
apps/api        API, scheduler, SQL migrations and tests
apps/web        Next.js web app
e2e             Browser tests
deploy          Reverse proxy configuration
docs            Screenshots, decision records and deployment guide
```

## Deployment

A [single-server deployment guide](docs/deployment.md) with Caddy and automatic HTTPS is included.
CI validates its Compose file, but it has not been run on a real server.

## Known limitations

- Email addresses are not verified and there is no password reset yet.
- Sign-up reveals whether an email address already has an account.
- Single sign-on always returns to the dashboard, so an invite link has to be opened again.
- A single failed check marks a service as down. Alerts and incidents arrive in phase 2.
- Checks run inside the API process. Phase 2 moves them to separate workers.
- Open sign-up lets anyone make the server send requests to public URLs, within per-user limits.

## Roadmap

- [x] **1. Working product:** accounts, teams, checks, dashboard, status page
- [ ] **2. Event pipeline:** Go workers, Kafka, Redis, live updates, alerts
- [ ] **3. Delivery:** Terraform and Argo CD on a local Kubernetes cluster
- [ ] **4. Reliability and security:** tracing, metrics, load tests, failure drills
- [ ] **5. AI assistant:** runbook search and incident summaries with a local model
- [ ] **6. Billing and presentation:** Stripe test mode and a demo video

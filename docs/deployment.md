# Deploy to a single server

This runs the whole app with automatic HTTPS on one small Linux server.

## You need

- A server with Docker and the Compose plugin. Allow about 2 GB of memory for building the images.
- A domain or subdomain with a DNS record pointing at the server.
- Ports 80 and 443 open. Open SSH only as far as you need it. Nothing else needs to be public.

## First deployment

```sh
git clone https://github.com/T-S-T-T/Pulseboard.git
cd Pulseboard
cp .env.production.example .env.production
chmod 600 .env.production
```

Edit `.env.production`: set `DOMAIN`, and set both passwords to separate values from
`openssl rand -hex 24`. Use hex values, because the passwords are placed inside connection URLs.

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

Caddy obtains the TLS certificate on first start. Check `https://<your domain>/api/ready`, then sign
up, add `https://does-not-exist.invalid/` and confirm the check shows as down.

## Update

```sh
git pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

Migrations run automatically before the API starts. They only move forward.

## Back up and restore

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml \
  exec -T db pg_dump -U pulseboard -Fc pulseboard > pulseboard.dump
```

Restore into an empty database with `pg_restore -U pulseboard -d pulseboard`. The
`pulseboard_app` role is not part of the dump; the migrate service creates it. Copy backups off the
server.

## Hardening

- The application blocks requests to private addresses. As a second layer, add firewall rules that
  stop containers reaching your cloud provider's metadata address and private network.
- `POSTGRES_PASSWORD` is applied only when the database volume is first created.

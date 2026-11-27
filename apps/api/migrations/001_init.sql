-- Pulseboard phase 1 schema.
--
-- Security model:
--   * Migrations run as the schema owner.
--   * The API connects as pulseboard_app, which owns nothing and is subject to
--     row-level security (RLS).
--   * Each request that touches tenant data runs in a transaction with
--     app.user_id set. Policies derive access from that user's memberships.
--   * The few operations that must work outside a membership (sign-in, joining
--     a team, the scheduler, public status pages) go through narrow
--     SECURITY DEFINER functions.

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO pulseboard_app;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

---------------------------------------------------------------------------
-- Tables
---------------------------------------------------------------------------

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL CHECK (char_length(email) <= 254),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE user_identities (
  issuer  text NOT NULL,
  subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  PRIMARY KEY (issuer, subject)
);

CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE teams (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  slug                text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status_page_enabled boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  team_id    uuid NOT NULL REFERENCES teams ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL REFERENCES teams ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,
  role        text NOT NULL CHECK (role IN ('admin', 'member')),
  created_by  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id          uuid NOT NULL REFERENCES teams ON DELETE CASCADE,
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  url              text NOT NULL CHECK (char_length(url) <= 2000),
  method           text NOT NULL DEFAULT 'GET' CHECK (method IN ('GET', 'HEAD')),
  interval_seconds integer NOT NULL DEFAULT 60 CHECK (interval_seconds BETWEEN 60 AND 3600),
  timeout_ms       integer NOT NULL DEFAULT 5000 CHECK (timeout_ms BETWEEN 1000 AND 15000),
  enabled          boolean NOT NULL DEFAULT true,
  is_public        boolean NOT NULL DEFAULT false,
  next_check_at    timestamptz NOT NULL DEFAULT now(),
  last_ok          boolean,
  last_status_code integer,
  last_latency_ms  integer,
  last_error       text,
  last_checked_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, id)
);
CREATE INDEX services_due_idx ON services (next_check_at) WHERE enabled;

CREATE TABLE check_results (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id     uuid NOT NULL,
  service_id  uuid NOT NULL,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  ok          boolean NOT NULL,
  status_code integer,
  latency_ms  integer,
  error       text,
  FOREIGN KEY (team_id, service_id) REFERENCES services (team_id, id) ON DELETE CASCADE
);
CREATE INDEX check_results_service_idx ON check_results (service_id, checked_at DESC);
CREATE INDEX check_results_age_idx ON check_results (checked_at);

---------------------------------------------------------------------------
-- Access helpers
---------------------------------------------------------------------------

CREATE FUNCTION current_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- SECURITY DEFINER so that policies on memberships do not recurse.
CREATE FUNCTION team_role(p_team uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT role FROM memberships WHERE team_id = p_team AND user_id = current_user_id()
$$;

CREATE FUNCTION has_role(p_team uuid, p_minimum text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    array_position(ARRAY['member', 'admin', 'owner'], team_role(p_team))
      >= array_position(ARRAY['member', 'admin', 'owner'], p_minimum),
    false)
$$;

---------------------------------------------------------------------------
-- Row-level security
---------------------------------------------------------------------------

ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams           ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships     ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites         ENABLE ROW LEVEL SECURITY;
ALTER TABLE services        ENABLE ROW LEVEL SECURITY;
ALTER TABLE check_results   ENABLE ROW LEVEL SECURITY;

-- users, user_identities and sessions have no grants and no policies: they are
-- reachable only through the functions below.

GRANT SELECT ON teams TO pulseboard_app;
GRANT UPDATE (name, status_page_enabled) ON teams TO pulseboard_app;
CREATE POLICY teams_read ON teams FOR SELECT USING (team_role(id) IS NOT NULL);
CREATE POLICY teams_update ON teams FOR UPDATE
  USING (has_role(id, 'admin')) WITH CHECK (has_role(id, 'admin'));

GRANT SELECT, DELETE ON memberships TO pulseboard_app;
GRANT UPDATE (role) ON memberships TO pulseboard_app;
CREATE POLICY memberships_read ON memberships FOR SELECT
  USING (team_role(team_id) IS NOT NULL);
CREATE POLICY memberships_update ON memberships FOR UPDATE
  USING (has_role(team_id, 'owner')) WITH CHECK (has_role(team_id, 'owner'));
CREATE POLICY memberships_delete ON memberships FOR DELETE
  USING (has_role(team_id, 'owner') OR user_id = current_user_id());

GRANT SELECT, DELETE ON invites TO pulseboard_app;
GRANT INSERT (team_id, token_hash, role, created_by, expires_at) ON invites TO pulseboard_app;
CREATE POLICY invites_read ON invites FOR SELECT USING (has_role(team_id, 'admin'));
CREATE POLICY invites_delete ON invites FOR DELETE USING (has_role(team_id, 'admin'));
CREATE POLICY invites_insert ON invites FOR INSERT WITH CHECK (
  created_by = current_user_id()
  AND has_role(team_id, 'admin')
  AND (role = 'member' OR has_role(team_id, 'owner'))
);

GRANT SELECT, DELETE ON services TO pulseboard_app;
GRANT INSERT (team_id, name, url, method, interval_seconds, timeout_ms, enabled, is_public)
  ON services TO pulseboard_app;
-- Check state (last_*) is written only by record_check().
GRANT UPDATE (name, url, method, interval_seconds, timeout_ms, enabled, is_public)
  ON services TO pulseboard_app;
CREATE POLICY services_read ON services FOR SELECT USING (team_role(team_id) IS NOT NULL);
CREATE POLICY services_insert ON services FOR INSERT WITH CHECK (has_role(team_id, 'admin'));
CREATE POLICY services_update ON services FOR UPDATE
  USING (has_role(team_id, 'admin')) WITH CHECK (has_role(team_id, 'admin'));
CREATE POLICY services_delete ON services FOR DELETE USING (has_role(team_id, 'admin'));

GRANT SELECT ON check_results TO pulseboard_app;
CREATE POLICY check_results_read ON check_results FOR SELECT
  USING (team_role(team_id) IS NOT NULL);

---------------------------------------------------------------------------
-- Guard rails
---------------------------------------------------------------------------

-- A team must always keep at least one owner.
CREATE FUNCTION protect_last_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role <> 'owner') THEN
    -- Lock the team so two owners cannot demote each other concurrently.
    PERFORM 1 FROM teams WHERE id = OLD.team_id FOR UPDATE;
    IF FOUND AND NOT EXISTS (
      SELECT 1 FROM memberships
      WHERE team_id = OLD.team_id AND role = 'owner' AND user_id <> OLD.user_id
    ) THEN
      RAISE EXCEPTION 'last_owner';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_last_owner BEFORE UPDATE OR DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION protect_last_owner();

-- Limits how much outbound traffic one team can generate.
CREATE FUNCTION limit_services() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM teams WHERE id = NEW.team_id FOR UPDATE;
  IF (SELECT count(*) FROM services WHERE team_id = NEW.team_id) >= 20 THEN
    RAISE EXCEPTION 'service_limit';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER services_limit BEFORE INSERT ON services
  FOR EACH ROW EXECUTE FUNCTION limit_services();

-- A new URL is a new target: forget the old state and history.
CREATE FUNCTION reset_check_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.last_ok := NULL;
  NEW.last_status_code := NULL;
  NEW.last_latency_ms := NULL;
  NEW.last_error := NULL;
  NEW.last_checked_at := NULL;
  NEW.next_check_at := now();
  DELETE FROM check_results WHERE service_id = NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER services_url_changed BEFORE UPDATE OF url ON services
  FOR EACH ROW WHEN (OLD.url IS DISTINCT FROM NEW.url)
  EXECUTE FUNCTION reset_check_state();

---------------------------------------------------------------------------
-- Identity
---------------------------------------------------------------------------

CREATE FUNCTION auth_register(p_email text, p_name text, p_password_hash text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  INSERT INTO users (email, name, password_hash)
  VALUES (p_email, p_name, p_password_hash)
  RETURNING id
$$;

CREATE FUNCTION auth_find_by_email(p_email text)
RETURNS TABLE (id uuid, email text, name text, password_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.email, u.name, u.password_hash FROM users u
  WHERE lower(u.email) = lower(p_email)
$$;

CREATE FUNCTION auth_create_session(p_user uuid, p_token_hash bytea, p_expires timestamptz)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (p_token_hash, p_user, p_expires)
$$;

CREATE FUNCTION auth_session_user(p_token_hash bytea)
RETURNS TABLE (id uuid, email text, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.email, u.name
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash AND s.expires_at > now()
$$;

CREATE FUNCTION auth_delete_session(p_token_hash bytea) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ DELETE FROM sessions WHERE token_hash = p_token_hash $$;

-- Sign-in through an OpenID Connect provider. An existing account with the same
-- email is deliberately NOT linked: password sign-up does not verify email, so
-- automatic linking would let someone pre-register another person's address.
CREATE FUNCTION auth_oidc_login(p_issuer text, p_subject text, p_email text, p_name text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid;
BEGIN
  SELECT user_id INTO v_user FROM user_identities
  WHERE issuer = p_issuer AND subject = p_subject;
  IF v_user IS NOT NULL THEN
    RETURN v_user;
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(p_email)) THEN
    RAISE EXCEPTION 'email_in_use';
  END IF;
  INSERT INTO users (email, name) VALUES (p_email, p_name) RETURNING id INTO v_user;
  INSERT INTO user_identities (issuer, subject, user_id) VALUES (p_issuer, p_subject, v_user);
  RETURN v_user;
END $$;

---------------------------------------------------------------------------
-- Teams
---------------------------------------------------------------------------

CREATE FUNCTION create_team(p_name text, p_slug text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := current_user_id();
  v_team uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  PERFORM 1 FROM users WHERE id = v_user FOR UPDATE;
  IF (SELECT count(*) FROM memberships WHERE user_id = v_user AND role = 'owner') >= 5 THEN
    RAISE EXCEPTION 'team_limit';
  END IF;
  INSERT INTO teams (name, slug) VALUES (p_name, p_slug) RETURNING id INTO v_team;
  INSERT INTO memberships (team_id, user_id, role) VALUES (v_team, v_user, 'owner');
  RETURN v_team;
END $$;

CREATE FUNCTION accept_invite(p_token_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := current_user_id();
  v_invite invites%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  -- The creator must still be allowed to issue this invite, so removing or
  -- demoting someone also disables the invites they handed out.
  SELECT i.* INTO v_invite FROM invites i
  WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.expires_at > now()
    AND EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.team_id = i.team_id AND m.user_id = i.created_by
        AND (m.role = 'owner' OR (m.role = 'admin' AND i.role = 'member'))
    )
  FOR UPDATE OF i;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_invite';
  END IF;
  INSERT INTO memberships (team_id, user_id, role)
  VALUES (v_invite.team_id, v_user, v_invite.role)
  ON CONFLICT (team_id, user_id) DO NOTHING;
  -- Someone who is already a member does not use up the invite.
  IF FOUND THEN
    UPDATE invites SET accepted_at = now() WHERE id = v_invite.id;
  END IF;
  RETURN v_invite.team_id;
END $$;

CREATE FUNCTION list_team_members(p_team uuid)
RETURNS TABLE (user_id uuid, name text, email text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.name, u.email, m.role
  FROM memberships m JOIN users u ON u.id = m.user_id
  WHERE m.team_id = p_team AND team_role(p_team) IS NOT NULL
  ORDER BY m.created_at, u.id
$$;

---------------------------------------------------------------------------
-- Scheduler
---------------------------------------------------------------------------

-- Claims due services by pushing next_check_at forward. SKIP LOCKED lets several
-- API instances run schedulers without checking the same service twice.
CREATE FUNCTION claim_due_services(p_limit integer)
RETURNS TABLE (id uuid, url text, method text, timeout_ms integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH due AS (
    SELECT s.id FROM services s
    WHERE s.enabled AND s.next_check_at <= now()
    ORDER BY s.next_check_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE services s
  SET next_check_at = now() + make_interval(secs => s.interval_seconds)
  FROM due
  WHERE s.id = due.id
  RETURNING s.id, s.url, s.method, s.timeout_ms
$$;

-- The URL guard drops a result if the service was edited while being checked.
CREATE FUNCTION record_check(
  p_service uuid, p_url text, p_ok boolean, p_status integer, p_latency integer, p_error text
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH updated AS (
    UPDATE services
    SET last_ok = p_ok, last_status_code = p_status, last_latency_ms = p_latency,
        last_error = p_error, last_checked_at = now()
    WHERE id = p_service AND url = p_url
    RETURNING team_id, id
  )
  INSERT INTO check_results (team_id, service_id, ok, status_code, latency_ms, error)
  SELECT team_id, id, p_ok, p_status, p_latency, p_error FROM updated
$$;

CREATE FUNCTION purge_expired(p_retention_days integer) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  DELETE FROM check_results WHERE checked_at < now() - make_interval(days => p_retention_days);
  DELETE FROM sessions WHERE expires_at < now();
$$;

---------------------------------------------------------------------------
-- Public status page
---------------------------------------------------------------------------

-- Returns NULL unless the team has published its page. Never exposes URLs,
-- error text or internal identifiers.
CREATE FUNCTION public_status(p_slug text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'team', t.name,
    'services', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'name', s.name,
        'ok', s.last_ok,
        'lastCheckedAt', s.last_checked_at,
        'uptime24h', (
          SELECT round(100.0 * count(*) FILTER (WHERE r.ok) / nullif(count(*), 0), 2)
          FROM check_results r
          WHERE r.service_id = s.id AND r.checked_at > now() - interval '24 hours'
        ),
        'recent', coalesce((
          SELECT jsonb_agg(jsonb_build_object('ok', h.ok, 'checkedAt', h.checked_at)
                           ORDER BY h.checked_at)
          FROM (
            SELECT r.ok, r.checked_at FROM check_results r
            WHERE r.service_id = s.id ORDER BY r.checked_at DESC LIMIT 30
          ) h
        ), '[]'::jsonb)
      ) ORDER BY s.created_at, s.id)
      FROM services s
      WHERE s.team_id = t.id AND s.is_public AND s.enabled
    ), '[]'::jsonb)
  )
  FROM teams t
  WHERE t.slug = p_slug AND t.status_page_enabled
$$;

---------------------------------------------------------------------------
-- Function privileges
---------------------------------------------------------------------------

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  current_user_id(),
  team_role(uuid),
  has_role(uuid, text),
  auth_register(text, text, text),
  auth_find_by_email(text),
  auth_create_session(uuid, bytea, timestamptz),
  auth_session_user(bytea),
  auth_delete_session(bytea),
  auth_oidc_login(text, text, text, text),
  create_team(text, text),
  accept_invite(bytea),
  list_team_members(uuid),
  claim_due_services(integer),
  record_check(uuid, text, boolean, integer, integer, text),
  purge_expired(integer),
  public_status(text)
TO pulseboard_app;

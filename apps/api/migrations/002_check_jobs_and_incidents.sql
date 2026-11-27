-- Phase 2, step 1: checks that survive a crash, and incidents.
--
-- Invariants:
--   * A due check becomes a row in check_jobs and stays there until its result
--     is recorded. If whoever leased it dies, the lease expires and the job is
--     handed out again.
--   * A service has at most one job at a time, so an older result can never
--     arrive after a newer one.
--   * Recording a result deletes its job, so recording it twice does nothing.
--   * A service has at most one open incident.
--
-- Lock order: lock the service row before touching its job. Edits, deletes and
-- complete_check_job() all follow it, which prevents deadlocks between them.

---------------------------------------------------------------------------
-- Tables
---------------------------------------------------------------------------

CREATE TABLE check_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      uuid NOT NULL,
  service_id   uuid NOT NULL UNIQUE,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz,
  attempts     integer NOT NULL DEFAULT 0,
  FOREIGN KEY (team_id, service_id) REFERENCES services (team_id, id) ON DELETE CASCADE
);
CREATE INDEX check_jobs_scheduled_idx ON check_jobs (scheduled_at);

ALTER TABLE services ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0;

CREATE TABLE incidents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL,
  service_id  uuid NOT NULL,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  -- The failure that opened the incident.
  error       text,
  FOREIGN KEY (team_id, service_id) REFERENCES services (team_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX incidents_one_open_idx ON incidents (service_id) WHERE resolved_at IS NULL;
CREATE INDEX incidents_team_idx ON incidents (team_id, opened_at DESC);
CREATE INDEX incidents_service_idx ON incidents (service_id);

-- check_jobs has no grants and no policies: only the functions below use it.
ALTER TABLE check_jobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON incidents TO pulseboard_app;
CREATE POLICY incidents_read ON incidents FOR SELECT USING (team_role(team_id) IS NOT NULL);

---------------------------------------------------------------------------
-- Edits to a service
---------------------------------------------------------------------------

-- A new URL is a new target: forget the old state, history and pending job.
CREATE OR REPLACE FUNCTION reset_check_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.last_ok := NULL;
  NEW.last_status_code := NULL;
  NEW.last_latency_ms := NULL;
  NEW.last_error := NULL;
  NEW.last_checked_at := NULL;
  NEW.consecutive_failures := 0;
  NEW.next_check_at := now();
  DELETE FROM check_jobs WHERE service_id = NEW.id;
  DELETE FROM check_results WHERE service_id = NEW.id;
  DELETE FROM incidents WHERE service_id = NEW.id;
  RETURN NEW;
END $$;

-- Pausing cancels the pending check and ends any open incident.
CREATE FUNCTION pause_service() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.consecutive_failures := 0;
  DELETE FROM check_jobs WHERE service_id = NEW.id;
  UPDATE incidents SET resolved_at = now() WHERE service_id = NEW.id AND resolved_at IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER services_paused BEFORE UPDATE OF enabled ON services
  FOR EACH ROW WHEN (OLD.enabled AND NOT NEW.enabled)
  EXECUTE FUNCTION pause_service();

---------------------------------------------------------------------------
-- Scheduler
---------------------------------------------------------------------------

DROP FUNCTION claim_due_services(integer);
DROP FUNCTION record_check(uuid, text, boolean, integer, integer, text);

-- Turns due services into jobs. Returns the number of jobs created.
CREATE FUNCTION schedule_check_jobs(p_limit integer) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH due AS (
    SELECT s.id FROM services s
    WHERE s.enabled AND s.next_check_at <= now()
      AND NOT EXISTS (SELECT 1 FROM check_jobs j WHERE j.service_id = s.id)
    ORDER BY s.next_check_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  advanced AS (
    UPDATE services s
    SET next_check_at = now() + make_interval(secs => s.interval_seconds)
    FROM due
    WHERE s.id = due.id
    RETURNING s.team_id, s.id
  ),
  created AS (
    INSERT INTO check_jobs (team_id, service_id)
    SELECT team_id, id FROM advanced
    ON CONFLICT (service_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer FROM created
$$;

-- Hands out waiting jobs, and jobs whose previous holder let the lease expire.
CREATE FUNCTION lease_check_jobs(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (job_id uuid, url text, method text, timeout_ms integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH available AS (
    SELECT j.id FROM check_jobs j
    WHERE j.leased_until IS NULL OR j.leased_until <= now()
    ORDER BY j.scheduled_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  leased AS (
    UPDATE check_jobs j
    SET leased_until = now() + make_interval(secs => p_lease_seconds),
        attempts = j.attempts + 1
    FROM available a
    WHERE j.id = a.id
    RETURNING j.id, j.service_id
  )
  SELECT l.id, s.url, s.method, s.timeout_ms
  FROM leased l JOIN services s ON s.id = l.service_id
$$;

-- Records one result, updates the service and opens or resolves its incident,
-- all in one transaction. Returns false, changing nothing, if the job is gone:
-- already recorded, or cancelled because the service was edited or removed.
CREATE FUNCTION complete_check_job(
  p_job uuid, p_ok boolean, p_status integer, p_latency integer, p_error text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  -- Failures in a row before an incident opens, so one blip does not raise one.
  c_threshold constant integer := 2;
  v_service uuid;
  v_team uuid;
  v_failures integer;
BEGIN
  SELECT service_id INTO v_service FROM check_jobs WHERE id = p_job;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM services WHERE id = v_service FOR UPDATE;
  -- Look again now that the service is locked.
  DELETE FROM check_jobs WHERE id = p_job RETURNING team_id INTO v_team;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE services
  SET last_ok = p_ok, last_status_code = p_status, last_latency_ms = p_latency,
      last_error = p_error, last_checked_at = now(),
      consecutive_failures = CASE WHEN p_ok THEN 0 ELSE consecutive_failures + 1 END
  WHERE id = v_service
  RETURNING consecutive_failures INTO v_failures;

  INSERT INTO check_results (team_id, service_id, ok, status_code, latency_ms, error)
  VALUES (v_team, v_service, p_ok, p_status, p_latency, p_error);

  IF p_ok THEN
    UPDATE incidents SET resolved_at = now()
    WHERE service_id = v_service AND resolved_at IS NULL;
  ELSIF v_failures >= c_threshold THEN
    INSERT INTO incidents (team_id, service_id, error)
    VALUES (v_team, v_service, p_error)
    ON CONFLICT (service_id) WHERE resolved_at IS NULL DO NOTHING;
  END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION purge_expired(p_retention_days integer) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  DELETE FROM check_results WHERE checked_at < now() - make_interval(days => p_retention_days);
  DELETE FROM incidents WHERE resolved_at < now() - make_interval(days => p_retention_days);
  DELETE FROM sessions WHERE expires_at < now();
$$;

---------------------------------------------------------------------------
-- Function privileges
---------------------------------------------------------------------------

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  schedule_check_jobs(integer),
  lease_check_jobs(integer, integer),
  complete_check_job(uuid, boolean, integer, integer, text)
TO pulseboard_app;

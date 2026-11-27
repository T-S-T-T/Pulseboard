# 5. Keep every check as a job until its result is recorded

**Status:** accepted

## Context

Phase 1 set a service's next check time before running the check. If the process stopped midway,
that check was lost. Phase 2 sends checks to separate workers through a queue, where work can be
delivered more than once and workers can die at any moment.

## Decision

- Scheduling a due service creates a row in `check_jobs`.
- A job is leased to one holder. If no result arrives before the lease expires, it is handed out
  again.
- `complete_check_job` deletes the job and records the result in one transaction. A second report
  finds no job and changes nothing.
- A service has at most one job, so an older result cannot overwrite a newer one.
- An incident opens after two failures in a row. A unique index allows one open incident per service.
- Whoever changes a job locks its service row first, which prevents deadlocks with edits.

## Consequences

- A check can run more than once, but its result is recorded once. This suits `GET` and `HEAD`.
- An interrupted check is delayed by up to the lease time (60 seconds).
- A slow or stuck job delays the next check of that service only.
- The database remains the source of truth. A queue added later only carries job IDs and results.
- A job that can never complete is retried indefinitely. A dead-letter queue will cap this.
- Alerts are not sent yet. Sending them needs its own record, so that each is sent once where the
  receiver allows it.

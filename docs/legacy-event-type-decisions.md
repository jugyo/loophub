# Legacy event type compatibility decisions

This document records the keep-or-remove decision for four persisted event types that no current
non-test source produces. The `events` table is a durable log: removing a producer does not remove
rows already stored in user databases, and readers must continue to interpret those rows when they
still affect current behavior.

The audit covers non-test producers, current readers, saved-row compatibility, history and UI
effects, supporting indexes, and compatibility tests. Test fixtures that call `emitEvent` directly
exercise the saved-row readers; they are not current producers.

## `pull_request.ready_for_review`: keep

- **Producer:** none. The draft/ready transition that wrote this event was retired.
- **Readers:** `firstReadyForReviewAt` in `core/store/events.ts` supplies the first review boundary
  to `pullWorkDuration` in `core/serialize.ts`. `listRecentInProgressSessionUsageSamples` in
  `core/store/session-usage.ts` excludes sessions for pull requests whose implementation already
  reached that boundary.
- **Saved rows and UI:** historical rows still split implementation time from review time in pull
  request details. They also prevent completed implementations from contributing to the live token
  rate. Removing either reader would change current output for an unchanged database.
- **Index:** keep `idx_events_repo_ready_number_id`; both saved-row queries filter by repository and
  pull request number, and the query-plan contract is covered by `core/db.test.ts`.
- **Tests:** retain the duration cases in `core/pull-work-duration.test.ts`, the live-rate cases in
  `core/sessions-service.test.ts`, and the query-plan cases in `core/db.test.ts`.

## `dev.cost_stopped`: keep

- **Producer:** none. Automated development-agent cost stopping was retired.
- **Readers:** `hasAnyCostStopEvent` in `core/store/events.ts` supplies `cost_stopped` through
  `core/serialize.ts` and `core/serialize-status.ts`. `listNotificationSignalRows` in
  `core/store/notifications.ts` also reads the event while advancing its durable signal cursor.
- **Saved rows and UI:** historical rows continue to show the cost-stopped badge on an affected open
  pull request and preserve generated over-budget notification signals. Removing the readers would
  make previously stopped pull requests appear as if the stop never happened.
- **Index:** keep `idx_events_repo_cost_stopped_number_session_id`; it supports the saved-row pull
  request lookup, while `idx_events_type_id` supports the notification cursor scan. Their query
  plans are covered by `core/db.test.ts`.
- **Tests:** retain the store coverage in `core/store.test.ts`, notification coverage in
  `core/notifications-service.test.ts`, serialization and badge coverage, and the query-plan cases
  in `core/db.test.ts`.

## `workflow_run.merged`: keep

- **Producer:** none. Pull request termination now records `workflow_run.closed` where a run event is
  needed, and Workflow instruction delivery observes pull request source events directly.
- **Readers:** `core/workflow/source-events.ts` recognizes stored merge twins during source-event
  cutover classification. `core/workflow/event-payloads.ts` retains their typed payload, and
  `workflowRunHistoryEventJSON` in `core/serialize.ts` retains their dedicated history entry.
- **Saved rows and UI:** existing Workflow histories still render these rows as "Linked PR merged"
  with notable significance. Removing the dedicated reader would degrade them to the generic
  fallback, while removing twin classification could reinterpret rows encountered by an existing
  run cursor.
- **Index:** no event-type-specific index exists or is needed for this type.
- **Tests:** retain the legacy merge fixtures in `core/serialize.test.ts` and the source-event cutover
  coverage in `core/workflow/source-events.test.ts`.

## `workflow_run.usage_updated`: keep

- **Producer:** none. Workflow cost enforcement moved away from usage-update wake events.
- **Reader:** `workflowRunHistoryEventJSON` in `core/serialize.ts` retains a dedicated history entry.
- **Saved rows and UI:** older runs can contain many of these rows. The dedicated entry labels them
  "Usage updated" with routine significance; removing it would relabel them through the generic
  fallback and promote them to default significance in the history UI.
- **Index:** no event-type-specific index exists or is needed for this type.
- **Tests:** retain the saved-row history fixtures in `core/serialize.test.ts` and
  `core/workflow-runs-service.test.ts`.

## Cleanup result

No event type is approved for removal. Consequently, no reader, partial index, explanatory schema
comment, or compatibility test becomes obsolete in this cleanup. The approximate event-count text
in `core/db.ts` remains unchanged: it explains the write-amplification tradeoff of the two partial
indexes, and changing it independently would not follow from an approved event-type removal.

These decisions concern persisted legacy rows only and do not add any event producer or extend the
typed domain-event implementation.

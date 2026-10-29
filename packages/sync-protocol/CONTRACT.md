# Metadata sync protocol v1

`src/index.ts` is the authoritative TypeScript DTO and runtime validator. `schema.json` describes the JSON shape; authorization, expiry, subset counts, clock skew and revision checks additionally run on the server. Unknown fields are rejected. Version 1 is carried in every ingest envelope; package version 0.2.0 is independently pinned by its consumer.

`fixtures.json` contains synthetic usage, correction, quota and grant examples only. No credential, conversation, title, command, code, path or free-form task text is accepted. Project aliases are explicitly entered by the user (80 characters maximum, no path separators); local project names are not uploaded by default.

`POST /v1/ingest`: `{protocolVersion:1,batchId,events:[WireEvent]}` (maximum 500 events / 2 MiB). Device authentication determines user and workspace; these are never event fields. Response: `{ackSeq,accepted,duplicates,rejected:[{seq,reason}]}`. The ACK is issued after commit. Retrying an identical batch is safe; changed content with the same transport ID returns 409. Remove only acknowledged rows in the submitted batch, not every lower sequence.

Usage is a deduplicated increment. `total=input+output`; cached and reasoning are subsets. A correction replaces the original increment using compare-and-swap revisions and preserves its original `occurredAt`. Quota is an account/pool/window observation, never a project balance or additive counter. Missing percentage is `null`, never zero.

Grant time is `[from,to)` and retention is 1–365 days. `shareQuota` independently authorizes account observations; an empty `projectIds` list shares no task/usage data. One event may have multiple valid authorization edges; withdrawing one does not delete another valid edge. Revoke removes inaccessible center records; downloaded exports cannot be recalled.

Errors contain `{error,code}`. Codes: `unauthorized` (401), `forbidden` (403), `invalid_request` (400/other client errors), `conflict` (409), `rate_limited` (429), `internal_error` (500). Semantic ingest rejection reasons are row-level results, e.g. `grant_revoked`, `account_not_shared`, `project_not_shared`, `outside_time_scope`, `retention_expired`, `grant_expired`, `future_clock`, `correction_revision_conflict`.

Personal service endpoints: `/v1/self/register`, `/v1/me`, `/v1/pair/preview`, `/v1/pair/redeem`, `/v1/self/pair-codes`, `/v1/self/devices`, `/v1/self/recovery`, `/v1/grants`, `/v1/heartbeat`, `/v1/ingest`, `/v1/erase`, `/v1/self/overview`, `/v1/self/records`. Device rotation is `POST /v1/self/devices/:id/rotate`; revocation is `DELETE /v1/self/devices/:id`. Product recovery requires product-user authentication. Server-side ownership always applies.

Employee invitation preview/accept is a client-facing extension implemented by the separate enterprise service. It is not an organization management feature in the personal service.

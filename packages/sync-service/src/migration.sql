CREATE TABLE IF NOT EXISTS awm_schema(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS product_users(id text PRIMARY KEY, name text NOT NULL, token_hash text UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS workspaces(id text PRIMARY KEY, name text NOT NULL, kind text NOT NULL , created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS pair_codes(code_hash text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), user_id text NOT NULL REFERENCES product_users(id), label text NOT NULL, expires_at timestamptz NOT NULL, redeemed_at timestamptz);
CREATE TABLE IF NOT EXISTS devices(id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), user_id text NOT NULL REFERENCES product_users(id), physical_id text NOT NULL, environment_id text NOT NULL, label text NOT NULL, token_hash text UNIQUE NOT NULL, revoked_at timestamptz, last_seen_at timestamptz, ack_seq bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS grants(id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), user_id text NOT NULL REFERENCES product_users(id), account_ids jsonb NOT NULL, project_ids jsonb NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, share_quota boolean NOT NULL, retention_days integer NOT NULL CHECK(retention_days BETWEEN 1 AND 365), revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS receipts(device_id text REFERENCES devices(id), seq bigint NOT NULL, payload_hash text NOT NULL, result text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(device_id,seq));
CREATE TABLE IF NOT EXISTS batches(device_id text REFERENCES devices(id), batch_id text NOT NULL, payload_hash text NOT NULL, response jsonb NOT NULL, PRIMARY KEY(device_id,batch_id));
CREATE TABLE IF NOT EXISTS shared_events(workspace_id text NOT NULL REFERENCES workspaces(id), user_id text NOT NULL REFERENCES product_users(id), event_id text NOT NULL, grant_id text NOT NULL REFERENCES grants(id), device_id text NOT NULL REFERENCES devices(id), account_id text NOT NULL, project_id text, session_id text, kind text NOT NULL, occurred_at timestamptz NOT NULL, observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(workspace_id,user_id,event_id));
CREATE INDEX IF NOT EXISTS shared_scope_date ON shared_events(workspace_id,user_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS shared_account_date ON shared_events(workspace_id,account_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS shared_project_date ON shared_events(workspace_id,project_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS shared_expiry ON shared_events(expires_at);
CREATE INDEX IF NOT EXISTS shared_corrections ON shared_events(workspace_id,user_id,(payload->>'correctsEventId')) WHERE kind='usage_correction';
CREATE TABLE IF NOT EXISTS tombstones(workspace_id text NOT NULL, user_id text NOT NULL, scope text NOT NULL CHECK(scope IN('event','session')), target_id text NOT NULL, deleted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,user_id,scope,target_id));
CREATE TABLE IF NOT EXISTS audit_events(id bigserial PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), actor_id text NOT NULL, action text NOT NULL, target_id text, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO awm_schema(version) VALUES(1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS personal_owners(workspace_id text PRIMARY KEY REFERENCES workspaces(id), user_id text NOT NULL REFERENCES product_users(id));
ALTER TABLE devices ADD COLUMN IF NOT EXISTS collector_health text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS task_state text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS credential_updated_at timestamptz;
CREATE TABLE IF NOT EXISTS event_grants(workspace_id text NOT NULL,user_id text NOT NULL,event_id text NOT NULL,grant_id text NOT NULL REFERENCES grants(id),expires_at timestamptz NOT NULL,PRIMARY KEY(workspace_id,user_id,event_id,grant_id),FOREIGN KEY(workspace_id,user_id,event_id) REFERENCES shared_events(workspace_id,user_id,event_id) ON DELETE CASCADE);
INSERT INTO event_grants SELECT workspace_id,user_id,event_id,grant_id,expires_at FROM shared_events ON CONFLICT DO NOTHING;
CREATE OR REPLACE VIEW authorized_events AS SELECT e.* FROM shared_events e WHERE EXISTS(SELECT 1 FROM event_grants eg JOIN grants g ON g.id=eg.grant_id WHERE eg.workspace_id=e.workspace_id AND eg.user_id=e.user_id AND eg.event_id=e.event_id AND eg.expires_at>now() AND g.revoked_at IS NULL AND g.ends_at>now());
INSERT INTO awm_schema(version) VALUES(2) ON CONFLICT DO NOTHING;
ALTER TABLE pair_codes ADD COLUMN IF NOT EXISTS issuer_device_id text REFERENCES devices(id);
-- Add proof for newly issued codes only. Do not delete, consume, revoke or
-- backfill a guessed issuer into existing codes. Legacy rows remain unchanged.
ALTER TABLE pair_codes ADD COLUMN IF NOT EXISTS issuer_kind text CHECK(issuer_kind IN ('user','device'));
ALTER TABLE pair_codes ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS task_grant_id text REFERENCES grants(id);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS task_state_at timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS heartbeat_seq bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS device_registrations(user_id text NOT NULL REFERENCES product_users(id),workspace_id text NOT NULL REFERENCES workspaces(id),registration_id text NOT NULL,device_id text NOT NULL REFERENCES devices(id),PRIMARY KEY(user_id,workspace_id,registration_id));
INSERT INTO awm_schema(version) VALUES(4) ON CONFLICT DO NOTHING;

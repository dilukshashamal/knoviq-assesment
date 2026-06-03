CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS knoviq;

CREATE TABLE IF NOT EXISTS knoviq.schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO knoviq.schema_migrations (version, name)
VALUES ('001', 'extensions')
ON CONFLICT (version) DO NOTHING;

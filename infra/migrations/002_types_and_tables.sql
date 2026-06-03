DO $$
BEGIN
  CREATE TYPE knoviq.tenant_status AS ENUM ('active', 'suspended');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE knoviq.user_status AS ENUM ('active', 'disabled', 'invited');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE knoviq.tenant_role AS ENUM ('owner', 'admin', 'member', 'viewer');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE knoviq.document_status AS ENUM (
    'pending',
    'extracting',
    'chunking',
    'embedding',
    'ready',
    'failed',
    'archived'
  );
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE knoviq.document_visibility AS ENUM ('private', 'tenant', 'shared');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE knoviq.document_access_role AS ENUM ('viewer', 'editor');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE knoviq.conversation_status AS ENUM ('active', 'archived');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE knoviq.message_role AS ENUM ('system', 'user', 'assistant', 'tool');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE knoviq.tool_execution_status AS ENUM (
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE knoviq.llm_request_purpose AS ENUM (
    'chat',
    'tool_planning',
    'answer_synthesis',
    'validation',
    'embedding',
    'summarization'
  );
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE knoviq.metric_kind AS ENUM ('counter', 'gauge', 'histogram');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

CREATE OR REPLACE FUNCTION knoviq.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS knoviq.tenants (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  status knoviq.tenant_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knoviq.users (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  primary_tenant_id uuid REFERENCES knoviq.tenants (id) ON DELETE SET NULL,
  email text NOT NULL CHECK (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  password_hash text NOT NULL CHECK (length(password_hash) >= 32),
  full_name text,
  status knoviq.user_status NOT NULL DEFAULT 'active',
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knoviq.tenant_memberships (
  tenant_id uuid NOT NULL REFERENCES knoviq.tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES knoviq.users (id) ON DELETE CASCADE,
  role knoviq.tenant_role NOT NULL DEFAULT 'member',
  invited_by_user_id uuid REFERENCES knoviq.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS knoviq.refresh_tokens (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash text NOT NULL,
  rotated_from_token_id uuid REFERENCES knoviq.refresh_tokens (id) ON DELETE SET NULL,
  created_by_ip inet,
  user_agent text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES knoviq.tenant_memberships (tenant_id, user_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knoviq.documents (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES knoviq.tenants (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  original_filename text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('application/pdf', 'text/plain')),
  file_size_bytes bigint NOT NULL CHECK (
    file_size_bytes > 0
    AND file_size_bytes <= 52428800
  ),
  storage_key text NOT NULL,
  checksum_sha256 char(64) NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  status knoviq.document_status NOT NULL DEFAULT 'pending',
  visibility knoviq.document_visibility NOT NULL DEFAULT 'private',
  failure_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  token_count integer CHECK (token_count IS NULL OR token_count >= 0),
  processed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id)
    REFERENCES knoviq.tenant_memberships (tenant_id, user_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS knoviq.document_access_grants (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  user_id uuid NOT NULL,
  access_role knoviq.document_access_role NOT NULL DEFAULT 'viewer',
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, user_id),
  FOREIGN KEY (tenant_id, document_id)
    REFERENCES knoviq.documents (tenant_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES knoviq.tenant_memberships (tenant_id, user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES knoviq.tenant_memberships (tenant_id, user_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS knoviq.document_chunks (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL CHECK (length(trim(content)) > 0),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  token_count integer NOT NULL CHECK (token_count > 0),
  embedding public.vector(1536),
  embedding_model text,
  embedding_created_at timestamptz,
  source_page_start integer CHECK (source_page_start IS NULL OR source_page_start > 0),
  source_page_end integer CHECK (source_page_end IS NULL OR source_page_end > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (document_id, chunk_index),
  UNIQUE (tenant_id, document_id, content_hash),
  CHECK (
    source_page_start IS NULL
    OR source_page_end IS NULL
    OR source_page_end >= source_page_start
  ),
  CHECK (
    (embedding IS NULL AND embedding_model IS NULL AND embedding_created_at IS NULL)
    OR (embedding IS NOT NULL AND embedding_model IS NOT NULL AND embedding_created_at IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, document_id)
    REFERENCES knoviq.documents (tenant_id, id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knoviq.embedding_cache (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES knoviq.tenants (id) ON DELETE CASCADE,
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  embedding_model text NOT NULL,
  embedding public.vector(1536) NOT NULL,
  token_count integer CHECK (token_count IS NULL OR token_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, embedding_model, content_hash)
);

CREATE TABLE IF NOT EXISTS knoviq.conversations (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES knoviq.tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  title text,
  status knoviq.conversation_status NOT NULL DEFAULT 'active',
  summary text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_message_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES knoviq.tenant_memberships (tenant_id, user_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS knoviq.messages (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  parent_message_id uuid REFERENCES knoviq.messages (id) ON DELETE SET NULL,
  role knoviq.message_role NOT NULL,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_count integer CHECK (token_count IS NULL OR token_count >= 0),
  model_deployment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES knoviq.conversations (tenant_id, id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knoviq.message_citations (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  tenant_id uuid NOT NULL,
  message_id uuid NOT NULL,
  document_id uuid NOT NULL,
  chunk_id uuid NOT NULL,
  relevance_score real CHECK (
    relevance_score IS NULL
    OR (relevance_score >= 0 AND relevance_score <= 1)
  ),
  quote text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, chunk_id),
  FOREIGN KEY (tenant_id, message_id)
    REFERENCES knoviq.messages (tenant_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, document_id)
    REFERENCES knoviq.documents (tenant_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, chunk_id)
    REFERENCES knoviq.document_chunks (tenant_id, id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knoviq.tool_executions (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES knoviq.tenants (id) ON DELETE CASCADE,
  user_id uuid,
  conversation_id uuid,
  message_id uuid,
  request_id text,
  tool_name text NOT NULL CHECK (length(trim(tool_name)) > 0),
  status knoviq.tool_execution_status NOT NULL DEFAULT 'queued',
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES knoviq.tenant_memberships (tenant_id, user_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES knoviq.conversations (tenant_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, message_id)
    REFERENCES knoviq.messages (tenant_id, id)
    ON DELETE RESTRICT,
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE IF NOT EXISTS knoviq.llm_usage (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES knoviq.tenants (id) ON DELETE CASCADE,
  user_id uuid,
  conversation_id uuid,
  message_id uuid,
  request_id text,
  purpose knoviq.llm_request_purpose NOT NULL,
  provider text NOT NULL DEFAULT 'azure_openai',
  model_deployment text NOT NULL,
  model_name text,
  prompt_tokens integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  total_tokens integer GENERATED ALWAYS AS (prompt_tokens + completion_tokens) STORED,
  estimated_cost_usd numeric(12, 8) CHECK (
    estimated_cost_usd IS NULL
    OR estimated_cost_usd >= 0
  ),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  cached boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES knoviq.tenant_memberships (tenant_id, user_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES knoviq.conversations (tenant_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, message_id)
    REFERENCES knoviq.messages (tenant_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS knoviq.service_metrics (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  tenant_id uuid REFERENCES knoviq.tenants (id) ON DELETE CASCADE,
  service_name text NOT NULL,
  metric_name text NOT NULL,
  metric_kind knoviq.metric_kind NOT NULL,
  value numeric NOT NULL,
  unit text,
  labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knoviq.audit_logs (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  tenant_id uuid REFERENCES knoviq.tenants (id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES knoviq.users (id) ON DELETE SET NULL,
  action text NOT NULL CHECK (length(trim(action)) > 0),
  entity_type text NOT NULL CHECK (length(trim(entity_type)) > 0),
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO knoviq.schema_migrations (version, name)
VALUES ('002', 'types_and_tables')
ON CONFLICT (version) DO NOTHING;

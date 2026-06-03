CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_lower_uq
  ON knoviq.tenants (lower(slug));

CREATE INDEX IF NOT EXISTS tenants_status_idx
  ON knoviq.tenants (status);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq
  ON knoviq.users (lower(email));

CREATE INDEX IF NOT EXISTS users_primary_tenant_idx
  ON knoviq.users (primary_tenant_id);

CREATE INDEX IF NOT EXISTS tenant_memberships_user_idx
  ON knoviq.tenant_memberships (user_id);

CREATE INDEX IF NOT EXISTS tenant_memberships_role_idx
  ON knoviq.tenant_memberships (tenant_id, role);

CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_token_hash_uq
  ON knoviq.refresh_tokens (token_hash);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_active_idx
  ON knoviq.refresh_tokens (tenant_id, user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS documents_tenant_checksum_uq
  ON knoviq.documents (tenant_id, checksum_sha256)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS documents_tenant_owner_idx
  ON knoviq.documents (tenant_id, owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS documents_tenant_status_idx
  ON knoviq.documents (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS documents_metadata_gin_idx
  ON knoviq.documents USING gin (metadata);

CREATE INDEX IF NOT EXISTS document_access_grants_user_idx
  ON knoviq.document_access_grants (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS document_chunks_document_idx
  ON knoviq.document_chunks (tenant_id, document_id, chunk_index);

CREATE INDEX IF NOT EXISTS document_chunks_content_hash_idx
  ON knoviq.document_chunks (tenant_id, content_hash);

CREATE INDEX IF NOT EXISTS document_chunks_metadata_gin_idx
  ON knoviq.document_chunks USING gin (metadata);

CREATE INDEX IF NOT EXISTS document_chunks_embedding_hnsw_idx
  ON knoviq.document_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS embedding_cache_lookup_idx
  ON knoviq.embedding_cache (tenant_id, embedding_model, content_hash);

CREATE INDEX IF NOT EXISTS conversations_tenant_user_idx
  ON knoviq.conversations (tenant_id, user_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS conversations_status_idx
  ON knoviq.conversations (tenant_id, status);

CREATE INDEX IF NOT EXISTS messages_conversation_order_idx
  ON knoviq.messages (tenant_id, conversation_id, created_at, id);

CREATE INDEX IF NOT EXISTS messages_metadata_gin_idx
  ON knoviq.messages USING gin (metadata);

CREATE INDEX IF NOT EXISTS message_citations_message_idx
  ON knoviq.message_citations (tenant_id, message_id);

CREATE INDEX IF NOT EXISTS message_citations_chunk_idx
  ON knoviq.message_citations (tenant_id, chunk_id);

CREATE INDEX IF NOT EXISTS tool_executions_conversation_idx
  ON knoviq.tool_executions (tenant_id, conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS tool_executions_status_idx
  ON knoviq.tool_executions (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS tool_executions_request_idx
  ON knoviq.tool_executions (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tool_executions_input_gin_idx
  ON knoviq.tool_executions USING gin (input);

CREATE INDEX IF NOT EXISTS llm_usage_tenant_created_idx
  ON knoviq.llm_usage (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS llm_usage_conversation_idx
  ON knoviq.llm_usage (tenant_id, conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS llm_usage_purpose_idx
  ON knoviq.llm_usage (tenant_id, purpose, created_at DESC);

CREATE INDEX IF NOT EXISTS llm_usage_request_idx
  ON knoviq.llm_usage (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS service_metrics_lookup_idx
  ON knoviq.service_metrics (service_name, metric_name, recorded_at DESC);

CREATE INDEX IF NOT EXISTS service_metrics_tenant_idx
  ON knoviq.service_metrics (tenant_id, recorded_at DESC)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS service_metrics_labels_gin_idx
  ON knoviq.service_metrics USING gin (labels);

CREATE INDEX IF NOT EXISTS audit_logs_tenant_created_idx
  ON knoviq.audit_logs (tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_logs_actor_idx
  ON knoviq.audit_logs (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

INSERT INTO knoviq.schema_migrations (version, name)
VALUES ('003', 'indexes')
ON CONFLICT (version) DO NOTHING;

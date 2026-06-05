-- Migration 005: Support configurable embedding vector dimensions
--
-- Context: migrations 002 hardcoded vector(1536) for the embedding columns in
-- document_chunks and embedding_cache. The application already reads
-- AZURE_OPENAI_EMBEDDING_DIMENSIONS at runtime (defaulting to 1536), so the
-- schema and the application stay in sync for the default configuration.
--
-- This migration provides an idempotent helper procedure that operators can
-- call when deploying with a non-default embedding model that produces
-- different-dimensioned vectors (e.g., text-embedding-3-large = 3072 dims,
-- text-embedding-ada-002 = 1536 dims, or custom fine-tuned models).
--
-- Usage (run BEFORE inserting any embeddings with the new dimension):
--
--   CALL knoviq.resize_embedding_columns(3072);
--
-- The procedure is safe to call multiple times — it checks the current
-- dimension first and is a no-op when the column is already the correct size.
--
-- IMPORTANT: Resizing requires that the embedding columns are NULL-able (they
-- are in this schema). PostgreSQL ALTER COLUMN TYPE rewrites the table, so
-- run this during a maintenance window on large datasets.

CREATE OR REPLACE PROCEDURE knoviq.resize_embedding_columns(target_dims integer)
LANGUAGE plpgsql
AS $$
DECLARE
  current_dims integer;
BEGIN
  -- Check the current dimension of document_chunks.embedding
  SELECT atttypmod
  INTO current_dims
  FROM pg_attribute
  WHERE attrelid = 'knoviq.document_chunks'::regclass
    AND attname = 'embedding';

  IF current_dims IS NOT DISTINCT FROM target_dims THEN
    RAISE NOTICE 'embedding columns are already dimension %; no change needed', target_dims;
    RETURN;
  END IF;

  RAISE NOTICE 'Resizing embedding columns from % to % dimensions', current_dims, target_dims;

  -- Resize document_chunks.embedding
  EXECUTE format(
    'ALTER TABLE knoviq.document_chunks ALTER COLUMN embedding TYPE public.vector(%s)',
    target_dims
  );

  -- Resize embedding_cache.embedding
  EXECUTE format(
    'ALTER TABLE knoviq.embedding_cache ALTER COLUMN embedding TYPE public.vector(%s)',
    target_dims
  );

  RAISE NOTICE 'Embedding columns resized to % dimensions successfully', target_dims;
END;
$$;

-- Record the default dimension so it is queryable at runtime without
-- parsing the column type. Applications can cross-check this against
-- AZURE_OPENAI_EMBEDDING_DIMENSIONS on startup.
CREATE TABLE IF NOT EXISTS knoviq.schema_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO knoviq.schema_config (key, value)
  VALUES ('embedding_dimensions', '1536')
  ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE knoviq.schema_config IS
  'Stores schema-level configuration values such as the current embedding vector dimension. '
  'Cross-check AZURE_OPENAI_EMBEDDING_DIMENSIONS against the ''embedding_dimensions'' key '
  'on service startup to detect dimension mismatches before inserting embeddings.';

COMMENT ON PROCEDURE knoviq.resize_embedding_columns IS
  'Idempotent helper to resize the embedding vector columns in document_chunks and '
  'embedding_cache to a new dimension. Call this before switching to an embedding model '
  'that produces vectors of a different size. Requires a table rewrite — run during '
  'a maintenance window on large datasets. Example: CALL knoviq.resize_embedding_columns(3072);';

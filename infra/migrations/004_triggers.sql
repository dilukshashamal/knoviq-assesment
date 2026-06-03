DROP TRIGGER IF EXISTS tenants_set_updated_at ON knoviq.tenants;
CREATE TRIGGER tenants_set_updated_at
BEFORE UPDATE ON knoviq.tenants
FOR EACH ROW
EXECUTE FUNCTION knoviq.set_updated_at();

DROP TRIGGER IF EXISTS users_set_updated_at ON knoviq.users;
CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON knoviq.users
FOR EACH ROW
EXECUTE FUNCTION knoviq.set_updated_at();

DROP TRIGGER IF EXISTS tenant_memberships_set_updated_at ON knoviq.tenant_memberships;
CREATE TRIGGER tenant_memberships_set_updated_at
BEFORE UPDATE ON knoviq.tenant_memberships
FOR EACH ROW
EXECUTE FUNCTION knoviq.set_updated_at();

DROP TRIGGER IF EXISTS documents_set_updated_at ON knoviq.documents;
CREATE TRIGGER documents_set_updated_at
BEFORE UPDATE ON knoviq.documents
FOR EACH ROW
EXECUTE FUNCTION knoviq.set_updated_at();

DROP TRIGGER IF EXISTS conversations_set_updated_at ON knoviq.conversations;
CREATE TRIGGER conversations_set_updated_at
BEFORE UPDATE ON knoviq.conversations
FOR EACH ROW
EXECUTE FUNCTION knoviq.set_updated_at();

INSERT INTO knoviq.schema_migrations (version, name)
VALUES ('004', 'triggers')
ON CONFLICT (version) DO NOTHING;

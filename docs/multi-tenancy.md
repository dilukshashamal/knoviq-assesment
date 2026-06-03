# Multi-Tenancy

## Model

Knoviq uses a **shared-database, tenant-scoped** data model. All tenant-owned records carry a `tenant_id` column. Services receive the active tenant from the verified JWT access token and pass it into every repository query.

No service accepts a tenant ID from the request body. Tenant context always comes from the token — clients cannot choose arbitrary tenants.

## Tenant Identity

Registration creates three records atomically:

- a `tenants` row
- a `users` row
- a `tenant_memberships` row with role `owner`

The issued access token contains:

| Claim | Value |
|---|---|
| `sub` | User ID |
| `tenant_id` | Active tenant ID |
| `role` | Active tenant role |
| `email` | User email |
| `jti` | Unique token ID (for revocation) |

Users can belong to multiple tenants. `POST /auth/login` accepts a `tenantSlug` field to request a token for a specific workspace. Without it, the user's primary tenant is used.

## Role Hierarchy

```
owner  >  admin  >  member  >  viewer
```

| Action | Minimum role |
|---|---|
| Ask questions, view answers | `viewer` |
| Upload documents | `contributor` (maps to `member`) |
| Run SQL reporting tools | `manager` (maps to `admin`) |
| Manage tenant members (non-owner) | `admin` |
| Manage owner memberships | `owner` |
| View audit reports | `admin` |

One owner must always remain. The system rejects any operation that would remove the last owner of a tenant.

## Service Isolation Pattern

Every backend service follows this pattern:

```typescript
// 1. Verify JWT → extract tenantId, userId, role
app.authenticate → request.principal

// 2. Validate membership when needed
await repository.ensureMembership(tenantId, userId)

// 3. Filter all queries by tenant
SELECT ... FROM knoviq.documents WHERE tenant_id = $1 AND ...
```

This keeps tenant context explicit at every service boundary and prevents cross-tenant data leaks.

## Document Access

Documents can have three visibility levels:

| Visibility | Who can access |
|---|---|
| `private` | Owner only |
| `tenant` | All active members of the tenant |
| `shared` | Owner + explicit `document_access_grants` rows |

Search results and document lists always apply this filter before returning data.

## Embedding Cache Isolation

The embedding cache (`knoviq.embedding_cache`) is scoped by `tenant_id` and `embedding_model`. A chunk with the same content hash in two different tenants does not share a cached embedding row, preventing information leakage through cache key collisions.

## Conversation Isolation

Conversations are owned by a single user within a tenant. The AI Gateway checks `assertConversationAccess(conversationId, tenantId, userId)` before loading message history. Users cannot access other users' conversations, even within the same tenant.

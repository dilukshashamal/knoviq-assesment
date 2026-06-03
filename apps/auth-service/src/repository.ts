import { randomBytes } from "node:crypto";
import { RoleSchema } from "@knoviq/contracts";
import type { Pool, PoolClient, QueryResultRow } from "@knoviq/database";
import { withTransaction } from "@knoviq/database";
import type { AuthRole } from "@knoviq/auth";

import { conflict, notFound, unauthorized } from "./errors.js";
import type {
  AuthContext,
  AuthenticatedUser,
  RequestMetadata,
  TenantMember,
  TenantSummary,
} from "./types.js";

interface TenantRow extends QueryResultRow {
  id: string;
  name: string;
  slug: string;
}

interface TenantSummaryRow extends QueryResultRow {
  role: string;
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
}

interface TenantMemberRow extends QueryResultRow {
  email: string;
  full_name: string | null;
  role: string;
  user_id: string;
  user_status: string;
}

interface AuthContextRow extends QueryResultRow {
  email: string;
  full_name: string | null;
  password_hash: string;
  role: string;
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  user_id: string;
  user_status: string;
}

interface RefreshTokenContextRow extends AuthContextRow {
  refresh_token_id: string;
}

export interface RegisterUserInput {
  email: string;
  fullName: string | undefined;
  passwordHash: string;
  refreshTokenExpiresAt: Date;
  refreshTokenHash: string;
  requestMetadata: RequestMetadata;
  tenantName: string | undefined;
  tenantSlug: string | undefined;
}

function firstRow<T>(rows: T[]): T | undefined {
  return rows.at(0);
}

function toAuthRole(value: string): AuthRole {
  return RoleSchema.parse(value);
}

function toAuthenticatedUser(row: AuthContextRow): AuthenticatedUser {
  return {
    email: row.email,
    fullName: row.full_name,
    role: toAuthRole(row.role),
    status: row.user_status,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    tenantSlug: row.tenant_slug,
    userId: row.user_id,
  };
}

function toAuthContext(row: AuthContextRow): AuthContext {
  return {
    email: row.email,
    role: toAuthRole(row.role),
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    tenantSlug: row.tenant_slug,
    userId: row.user_id,
  };
}

function toTenantSummary(row: TenantSummaryRow): TenantSummary {
  return {
    role: toAuthRole(row.role),
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    tenantSlug: row.tenant_slug,
  };
}

function toTenantMember(row: TenantMemberRow): TenantMember {
  return {
    email: row.email,
    fullName: row.full_name,
    role: toAuthRole(row.role),
    status: row.user_status,
    userId: row.user_id,
  };
}

function normalizeSlug(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  const trimmed = slug.slice(0, 64).replace(/-+$/g, "");

  if (trimmed.length >= 3) {
    return trimmed;
  }

  return `${trimmed || "tenant"}-ws`.slice(0, 64).replace(/-+$/g, "");
}

function randomSlugSuffix(): string {
  return randomBytes(3).toString("hex");
}

function buildTenantName(input: RegisterUserInput): string {
  if (input.tenantName) {
    return input.tenantName;
  }

  if (input.fullName) {
    return `${input.fullName}'s workspace`.slice(0, 100);
  }

  const emailPrefix = input.email.split("@").at(0) ?? "Knoviq";
  return `${emailPrefix}'s workspace`.slice(0, 100);
}

export class AuthRepository {
  constructor(private readonly pool: Pool) {}

  async registerUser(input: RegisterUserInput): Promise<AuthenticatedUser> {
    return withTransaction(this.pool, async (client) => {
      const existingUser = await client.query<{ id: string }>(
        "SELECT id FROM knoviq.users WHERE lower(email) = lower($1) LIMIT 1",
        [input.email],
      );

      if (existingUser.rowCount && existingUser.rowCount > 0) {
        throw conflict("A user with this email already exists");
      }

      const tenantName = buildTenantName(input);
      const tenant = await this.createTenant(client, tenantName, input.tenantSlug);

      const userResult = await client.query<AuthContextRow>(
        `
          INSERT INTO knoviq.users (primary_tenant_id, email, password_hash, full_name)
          VALUES ($1, $2, $3, $4)
          RETURNING
            id AS user_id,
            email,
            password_hash,
            full_name,
            status AS user_status,
            $1::uuid AS tenant_id,
            $5::text AS tenant_name,
            $6::text AS tenant_slug,
            'owner'::text AS role
        `,
        [
          tenant.id,
          input.email,
          input.passwordHash,
          input.fullName ?? null,
          tenant.name,
          tenant.slug,
        ],
      );
      const user = firstRow(userResult.rows);

      if (!user) {
        throw new Error("Failed to create user");
      }

      await client.query(
        `
          INSERT INTO knoviq.tenant_memberships (tenant_id, user_id, role)
          VALUES ($1, $2, 'owner')
        `,
        [tenant.id, user.user_id],
      );

      await this.insertRefreshToken(client, {
        expiresAt: input.refreshTokenExpiresAt,
        hash: input.refreshTokenHash,
        metadata: input.requestMetadata,
        rotatedFromTokenId: null,
        tenantId: tenant.id,
        userId: user.user_id,
      });

      return toAuthenticatedUser(user);
    });
  }

  async findLoginContext(email: string, tenantSlug: string | undefined) {
    const result = await this.pool.query<AuthContextRow>(
      `
        SELECT
          u.id AS user_id,
          u.email,
          u.password_hash,
          u.full_name,
          u.status AS user_status,
          t.id AS tenant_id,
          t.name AS tenant_name,
          t.slug AS tenant_slug,
          tm.role::text AS role
        FROM knoviq.users u
        JOIN knoviq.tenant_memberships tm ON tm.user_id = u.id
        JOIN knoviq.tenants t ON t.id = tm.tenant_id
        WHERE lower(u.email) = lower($1)
          AND u.status = 'active'
          AND t.status = 'active'
          AND ($2::text IS NULL OR lower(t.slug) = lower($2))
        ORDER BY
          CASE WHEN tm.tenant_id = u.primary_tenant_id THEN 0 ELSE 1 END,
          tm.created_at ASC
        LIMIT 1
      `,
      [email, tenantSlug ?? null],
    );
    const row = firstRow(result.rows);

    if (!row) {
      throw unauthorized("Invalid email, password, or tenant");
    }

    return {
      context: toAuthContext(row),
      passwordHash: row.password_hash,
      user: toAuthenticatedUser(row),
    };
  }

  async findCurrentUser(tenantId: string, userId: string): Promise<AuthenticatedUser> {
    const result = await this.pool.query<AuthContextRow>(
      `
        SELECT
          u.id AS user_id,
          u.email,
          u.password_hash,
          u.full_name,
          u.status AS user_status,
          t.id AS tenant_id,
          t.name AS tenant_name,
          t.slug AS tenant_slug,
          tm.role::text AS role
        FROM knoviq.users u
        JOIN knoviq.tenant_memberships tm ON tm.user_id = u.id
        JOIN knoviq.tenants t ON t.id = tm.tenant_id
        WHERE u.id = $1
          AND t.id = $2
          AND u.status = 'active'
          AND t.status = 'active'
        LIMIT 1
      `,
      [userId, tenantId],
    );
    const row = firstRow(result.rows);

    if (!row) {
      throw notFound("Authenticated user was not found");
    }

    return toAuthenticatedUser(row);
  }

  async listUserTenants(userId: string): Promise<TenantSummary[]> {
    const result = await this.pool.query<TenantSummaryRow>(
      `
        SELECT
          t.id AS tenant_id,
          t.name AS tenant_name,
          t.slug AS tenant_slug,
          tm.role::text AS role
        FROM knoviq.tenant_memberships tm
        JOIN knoviq.tenants t ON t.id = tm.tenant_id
        JOIN knoviq.users u ON u.id = tm.user_id
        WHERE tm.user_id = $1
          AND u.status = 'active'
          AND t.status = 'active'
        ORDER BY
          CASE WHEN t.id = u.primary_tenant_id THEN 0 ELSE 1 END,
          t.name ASC
      `,
      [userId],
    );

    return result.rows.map(toTenantSummary);
  }

  async listTenantMembers(tenantId: string): Promise<TenantMember[]> {
    const result = await this.pool.query<TenantMemberRow>(
      `
        SELECT
          u.id AS user_id,
          u.email,
          u.full_name,
          u.status AS user_status,
          tm.role::text AS role
        FROM knoviq.tenant_memberships tm
        JOIN knoviq.users u ON u.id = tm.user_id
        WHERE tm.tenant_id = $1
        ORDER BY
          CASE tm.role
            WHEN 'owner' THEN 0
            WHEN 'admin' THEN 1
            WHEN 'member' THEN 2
            ELSE 3
          END,
          lower(u.email) ASC
      `,
      [tenantId],
    );

    return result.rows.map(toTenantMember);
  }

  async addExistingUserToTenant(input: {
    email: string;
    role: AuthRole;
    tenantId: string;
  }): Promise<TenantMember> {
    const result = await this.pool.query<TenantMemberRow>(
      `
        WITH target_user AS (
          SELECT id, email, full_name, status
          FROM knoviq.users
          WHERE lower(email) = lower($2)
            AND status = 'active'
          LIMIT 1
        ),
        inserted AS (
          INSERT INTO knoviq.tenant_memberships (tenant_id, user_id, role)
          SELECT $1, id, $3::knoviq.tenant_role
          FROM target_user
          ON CONFLICT DO NOTHING
          RETURNING user_id, role::text
        )
        SELECT
          u.id AS user_id,
          u.email,
          u.full_name,
          u.status AS user_status,
          inserted.role
        FROM inserted
        JOIN knoviq.users u ON u.id = inserted.user_id
      `,
      [input.tenantId, input.email, input.role],
    );
    const row = firstRow(result.rows);

    if (row) {
      return toTenantMember(row);
    }

    const existingUser = await this.pool.query<{ id: string }>(
      "SELECT id FROM knoviq.users WHERE lower(email) = lower($1) LIMIT 1",
      [input.email],
    );

    if (!existingUser.rowCount) {
      throw notFound("User was not found. They must register before being added to a tenant.");
    }

    throw conflict("User is already a member of this tenant");
  }

  async updateTenantMemberRole(input: {
    role: AuthRole;
    tenantId: string;
    userId: string;
  }): Promise<TenantMember> {
    const current = await this.findTenantMember(input.tenantId, input.userId);

    if (current.role === "owner" && input.role !== "owner") {
      await this.ensureNotLastOwner(input.tenantId, input.userId);
    }

    const result = await this.pool.query<TenantMemberRow>(
      `
        UPDATE knoviq.tenant_memberships tm
        SET role = $3::knoviq.tenant_role,
            updated_at = now()
        FROM knoviq.users u
        WHERE tm.tenant_id = $1
          AND tm.user_id = $2
          AND u.id = tm.user_id
        RETURNING
          u.id AS user_id,
          u.email,
          u.full_name,
          u.status AS user_status,
          tm.role::text AS role
      `,
      [input.tenantId, input.userId, input.role],
    );
    const row = firstRow(result.rows);

    if (!row) {
      throw notFound("Tenant member was not found");
    }

    return toTenantMember(row);
  }

  async removeTenantMember(input: { tenantId: string; userId: string }): Promise<void> {
    const current = await this.findTenantMember(input.tenantId, input.userId);

    if (current.role === "owner") {
      await this.ensureNotLastOwner(input.tenantId, input.userId);
    }

    await this.pool.query(
      `
        DELETE FROM knoviq.tenant_memberships
        WHERE tenant_id = $1
          AND user_id = $2
      `,
      [input.tenantId, input.userId],
    );
  }

  async findTenantMember(tenantId: string, userId: string): Promise<TenantMember> {
    const result = await this.pool.query<TenantMemberRow>(
      `
        SELECT
          u.id AS user_id,
          u.email,
          u.full_name,
          u.status AS user_status,
          tm.role::text AS role
        FROM knoviq.tenant_memberships tm
        JOIN knoviq.users u ON u.id = tm.user_id
        WHERE tm.tenant_id = $1
          AND tm.user_id = $2
        LIMIT 1
      `,
      [tenantId, userId],
    );
    const row = firstRow(result.rows);

    if (!row) {
      throw notFound("Tenant member was not found");
    }

    return toTenantMember(row);
  }

  async createLoginRefreshToken(input: {
    expiresAt: Date;
    hash: string;
    metadata: RequestMetadata;
    tenantId: string;
    userId: string;
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await this.insertRefreshToken(client, {
        expiresAt: input.expiresAt,
        hash: input.hash,
        metadata: input.metadata,
        rotatedFromTokenId: null,
        tenantId: input.tenantId,
        userId: input.userId,
      });

      await client.query("UPDATE knoviq.users SET last_login_at = now() WHERE id = $1", [
        input.userId,
      ]);
    });
  }

  async findActiveRefreshToken(refreshTokenHash: string) {
    const result = await this.pool.query<RefreshTokenContextRow>(
      `
        SELECT
          rt.id AS refresh_token_id,
          u.id AS user_id,
          u.email,
          u.password_hash,
          u.full_name,
          u.status AS user_status,
          t.id AS tenant_id,
          t.name AS tenant_name,
          t.slug AS tenant_slug,
          tm.role::text AS role
        FROM knoviq.refresh_tokens rt
        JOIN knoviq.users u ON u.id = rt.user_id
        JOIN knoviq.tenant_memberships tm
          ON tm.user_id = rt.user_id
         AND tm.tenant_id = rt.tenant_id
        JOIN knoviq.tenants t ON t.id = rt.tenant_id
        WHERE rt.token_hash = $1
          AND rt.revoked_at IS NULL
          AND rt.expires_at > now()
          AND u.status = 'active'
          AND t.status = 'active'
        LIMIT 1
      `,
      [refreshTokenHash],
    );
    const row = firstRow(result.rows);

    if (!row) {
      throw unauthorized("Invalid or expired refresh token");
    }

    return {
      context: toAuthContext(row),
      refreshTokenId: row.refresh_token_id,
      user: toAuthenticatedUser(row),
    };
  }

  async rotateRefreshToken(input: {
    expiresAt: Date;
    hash: string;
    metadata: RequestMetadata;
    oldRefreshTokenId: string;
    tenantId: string;
    userId: string;
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const revoked = await client.query(
        `
          UPDATE knoviq.refresh_tokens
          SET revoked_at = now()
          WHERE id = $1
            AND revoked_at IS NULL
        `,
        [input.oldRefreshTokenId],
      );

      if (!revoked.rowCount) {
        throw unauthorized("Refresh token has already been used");
      }

      await this.insertRefreshToken(client, {
        expiresAt: input.expiresAt,
        hash: input.hash,
        metadata: input.metadata,
        rotatedFromTokenId: input.oldRefreshTokenId,
        tenantId: input.tenantId,
        userId: input.userId,
      });
    });
  }

  async revokeRefreshToken(refreshTokenHash: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE knoviq.refresh_tokens
        SET revoked_at = now()
        WHERE token_hash = $1
          AND revoked_at IS NULL
      `,
      [refreshTokenHash],
    );
  }

  private async createTenant(
    client: PoolClient,
    tenantName: string,
    requestedSlug: string | undefined,
  ): Promise<TenantRow> {
    const baseSlug = normalizeSlug(requestedSlug ?? tenantName);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const suffix = attempt === 0 ? "" : `-${randomSlugSuffix()}`;
      const slug = `${baseSlug.slice(0, 64 - suffix.length)}${suffix}`.replace(/-+$/g, "");
      const result = await client.query<TenantRow>(
        `
          INSERT INTO knoviq.tenants (name, slug)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
          RETURNING id, name, slug
        `,
        [tenantName, slug],
      );
      const row = firstRow(result.rows);

      if (row) {
        return row;
      }
    }

    throw conflict("Tenant slug is already in use");
  }

  private async ensureNotLastOwner(tenantId: string, userId: string): Promise<void> {
    const result = await this.pool.query<{ owner_count: number }>(
      `
        SELECT count(*)::int AS owner_count
        FROM knoviq.tenant_memberships
        WHERE tenant_id = $1
          AND role = 'owner'
          AND user_id <> $2
      `,
      [tenantId, userId],
    );
    const ownerCount = firstRow(result.rows)?.owner_count ?? 0;

    if (ownerCount === 0) {
      throw conflict("Tenant must keep at least one owner");
    }
  }

  private async insertRefreshToken(
    client: PoolClient,
    input: {
      expiresAt: Date;
      hash: string;
      metadata: RequestMetadata;
      rotatedFromTokenId: string | null;
      tenantId: string;
      userId: string;
    },
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO knoviq.refresh_tokens (
          tenant_id,
          user_id,
          token_hash,
          rotated_from_token_id,
          created_by_ip,
          user_agent,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        input.tenantId,
        input.userId,
        input.hash,
        input.rotatedFromTokenId,
        input.metadata.ipAddress ?? null,
        input.metadata.userAgent ?? null,
        input.expiresAt,
      ],
    );
  }
}

import { hasMinimumRole, type AuthPrincipal, type AuthRole } from "@knoviq/auth";

import type { AuthSettings } from "./config.js";
import { conflict, forbidden, unauthorized } from "./errors.js";
import { signAccessToken } from "./jwt.js";
import { hashPassword, verifyPassword } from "./password.js";
import {
  createOpaqueRefreshToken,
  getRefreshTokenExpiry,
  hashRefreshToken,
} from "./refresh-token.js";
import type {
  AddTenantMemberRequest,
  LoginRequest,
  RegisterRequest,
  UpdateTenantMemberRoleRequest,
} from "./schemas.js";
import type {
  AuthResponse,
  AuthenticatedUser,
  RequestMetadata,
  TenantMember,
  TenantSummary,
  TokenPair,
} from "./types.js";
import type { AuthRepository } from "./repository.js";

export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly settings: AuthSettings,
  ) {}

  async register(input: RegisterRequest, metadata: RequestMetadata): Promise<AuthResponse> {
    const passwordHash = await hashPassword(input.password);
    const refreshToken = createOpaqueRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken, this.settings.refreshSecret);
    const refreshTokenExpiresAt = getRefreshTokenExpiry(this.settings.refreshTtlSeconds);

    const user = await this.repository.registerUser({
      email: input.email,
      fullName: input.fullName,
      passwordHash,
      refreshTokenExpiresAt,
      refreshTokenHash,
      requestMetadata: metadata,
      tenantName: input.tenantName,
      tenantSlug: input.tenantSlug,
    });

    return {
      tokens: await this.buildTokenPair(user, refreshToken, refreshTokenExpiresAt),
      user,
    };
  }

  async login(input: LoginRequest, metadata: RequestMetadata): Promise<AuthResponse> {
    const loginContext = await this.repository.findLoginContext(input.email, input.tenantSlug);
    const passwordMatches = await verifyPassword(loginContext.passwordHash, input.password);

    if (!passwordMatches) {
      throw unauthorized("Invalid email, password, or tenant");
    }

    const refreshToken = createOpaqueRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken, this.settings.refreshSecret);
    const refreshTokenExpiresAt = getRefreshTokenExpiry(this.settings.refreshTtlSeconds);

    await this.repository.createLoginRefreshToken({
      expiresAt: refreshTokenExpiresAt,
      hash: refreshTokenHash,
      metadata,
      tenantId: loginContext.context.tenantId,
      userId: loginContext.context.userId,
    });

    return {
      tokens: await this.buildTokenPair(loginContext.user, refreshToken, refreshTokenExpiresAt),
      user: loginContext.user,
    };
  }

  async refresh(refreshToken: string, metadata: RequestMetadata): Promise<AuthResponse> {
    const oldRefreshTokenHash = hashRefreshToken(refreshToken, this.settings.refreshSecret);
    const activeToken = await this.repository.findActiveRefreshToken(oldRefreshTokenHash);
    const nextRefreshToken = createOpaqueRefreshToken();
    const nextRefreshTokenHash = hashRefreshToken(nextRefreshToken, this.settings.refreshSecret);
    const nextRefreshTokenExpiresAt = getRefreshTokenExpiry(this.settings.refreshTtlSeconds);

    await this.repository.rotateRefreshToken({
      expiresAt: nextRefreshTokenExpiresAt,
      hash: nextRefreshTokenHash,
      metadata,
      oldRefreshTokenId: activeToken.refreshTokenId,
      tenantId: activeToken.context.tenantId,
      userId: activeToken.context.userId,
    });

    return {
      tokens: await this.buildTokenPair(
        activeToken.user,
        nextRefreshToken,
        nextRefreshTokenExpiresAt,
      ),
      user: activeToken.user,
    };
  }

  async logout(refreshToken: string): Promise<void> {
    const refreshTokenHash = hashRefreshToken(refreshToken, this.settings.refreshSecret);
    await this.repository.revokeRefreshToken(refreshTokenHash);
  }

  async getCurrentUser(principal: AuthPrincipal): Promise<AuthenticatedUser> {
    return this.repository.findCurrentUser(principal.tenantId, principal.userId);
  }

  async listTenants(principal: AuthPrincipal): Promise<TenantSummary[]> {
    return this.repository.listUserTenants(principal.userId);
  }

  async listTenantMembers(principal: AuthPrincipal): Promise<TenantMember[]> {
    requireMinimumRole(principal.role, "admin");
    return this.repository.listTenantMembers(principal.tenantId);
  }

  async addTenantMember(
    principal: AuthPrincipal,
    input: AddTenantMemberRequest,
  ): Promise<TenantMember> {
    requireMinimumRole(principal.role, "admin");
    requireRoleManagementAllowed(principal.role, input.role);

    return this.repository.addExistingUserToTenant({
      email: input.email,
      role: input.role,
      tenantId: principal.tenantId,
    });
  }

  async updateTenantMemberRole(
    principal: AuthPrincipal,
    userId: string,
    input: UpdateTenantMemberRoleRequest,
  ): Promise<TenantMember> {
    requireMinimumRole(principal.role, "admin");
    const currentMember = await this.repository.findTenantMember(principal.tenantId, userId);

    requireRoleManagementAllowed(principal.role, currentMember.role);
    requireRoleManagementAllowed(principal.role, input.role);

    return this.repository.updateTenantMemberRole({
      role: input.role,
      tenantId: principal.tenantId,
      userId,
    });
  }

  async removeTenantMember(principal: AuthPrincipal, userId: string): Promise<void> {
    requireMinimumRole(principal.role, "admin");

    if (principal.userId === userId) {
      throw conflict("Use another tenant owner or admin to remove your membership");
    }

    const currentMember = await this.repository.findTenantMember(principal.tenantId, userId);

    requireRoleManagementAllowed(principal.role, currentMember.role);

    await this.repository.removeTenantMember({
      tenantId: principal.tenantId,
      userId,
    });
  }

  private async buildTokenPair(
    user: AuthenticatedUser,
    refreshToken: string,
    refreshTokenExpiresAt: Date,
  ): Promise<TokenPair> {
    const accessToken = await signAccessToken(
      {
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
        userId: user.userId,
      },
      this.settings,
    );

    return {
      accessToken,
      accessTokenExpiresInSeconds: this.settings.accessTtlSeconds,
      refreshToken,
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
      tokenType: "Bearer",
    };
  }
}

function requireMinimumRole(actual: AuthRole, required: AuthRole): void {
  if (!hasMinimumRole(actual, required)) {
    throw forbidden(`Requires ${required} role or higher`);
  }
}

function requireRoleManagementAllowed(actorRole: AuthRole, targetRole: AuthRole): void {
  if (targetRole === "owner" && actorRole !== "owner") {
    throw forbidden("Only tenant owners can manage owner memberships");
  }
}

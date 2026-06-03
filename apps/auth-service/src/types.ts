import type { AuthRole } from "@knoviq/auth";

export interface AuthContext {
  email: string;
  role: AuthRole;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  userId: string;
}

export interface AuthenticatedUser {
  email: string;
  fullName: string | null;
  role: AuthRole;
  status: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  userId: string;
}

export interface TenantSummary {
  role: AuthRole;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
}

export interface TenantMember {
  email: string;
  fullName: string | null;
  role: AuthRole;
  status: string;
  userId: string;
}

export interface RequestMetadata {
  ipAddress: string | undefined;
  userAgent: string | undefined;
}

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  tokenType: "Bearer";
}

export interface AuthResponse {
  tokens: TokenPair;
  user: AuthenticatedUser;
}

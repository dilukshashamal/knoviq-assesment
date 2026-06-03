export type AuthRole = "owner" | "admin" | "member" | "viewer";

export interface AuthPrincipal {
  role: AuthRole;
  tenantId: string;
  userId: string;
}

const roleRank: Record<AuthRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

export function hasMinimumRole(actual: AuthRole, required: AuthRole): boolean {
  return roleRank[actual] >= roleRank[required];
}

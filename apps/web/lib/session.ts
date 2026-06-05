export interface AuthUser {
  email: string;
  fullName: string | null;
  role: string;
  status?: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  userId: string;
}

export interface AuthResponse {
  tokens: {
    accessToken: string;
    refreshToken: string;
  };
  user: AuthUser;
}

export const SESSION_STORAGE_KEY = "knoviq.session";

export function threadStorageKey(userId: string): string {
  return `knoviq.chatThreads.${userId}`;
}

export function isAdminRole(role: string | undefined): boolean {
  return role === "admin" || role === "owner";
}

export function readStoredSession(): AuthResponse | null {
  if (typeof window === "undefined") {
    return null;
  }

  const storedSession = window.localStorage.getItem(SESSION_STORAGE_KEY);

  if (!storedSession) {
    return null;
  }

  try {
    return JSON.parse(storedSession) as AuthResponse;
  } catch {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
}

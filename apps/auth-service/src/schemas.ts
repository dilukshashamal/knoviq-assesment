import { z } from "zod";
import { RoleSchema } from "@knoviq/contracts";

const EmailSchema = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((email) => email.toLowerCase());
const PasswordSchema = z.string().min(12).max(128);
const TenantSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/);

export const RegisterRequestSchema = z.object({
  email: EmailSchema,
  fullName: z.string().trim().min(1).max(120).optional(),
  password: PasswordSchema,
  tenantName: z.string().trim().min(2).max(100).optional(),
  tenantSlug: TenantSlugSchema.optional(),
});

export const LoginRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(128),
  tenantSlug: TenantSlugSchema.optional(),
});

export const RefreshTokenRequestSchema = z.object({
  refreshToken: z.string().min(32).max(512),
});

export const LogoutRequestSchema = RefreshTokenRequestSchema;

export const AddTenantMemberRequestSchema = z.object({
  email: EmailSchema,
  role: RoleSchema.default("member"),
});

export const UpdateTenantMemberRoleRequestSchema = z.object({
  role: RoleSchema,
});

export const TenantMemberParamsSchema = z.object({
  userId: z.string().uuid(),
});

export type AddTenantMemberRequest = z.infer<typeof AddTenantMemberRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;
export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>;
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type TenantMemberParams = z.infer<typeof TenantMemberParamsSchema>;
export type UpdateTenantMemberRoleRequest = z.infer<typeof UpdateTenantMemberRoleRequestSchema>;

"use client";

import type { FormEvent } from "react";
import { Loader2, LogIn, UserPlus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface AuthFormProps {
  authLoading: boolean;
  authStatus: string | null;
  email: string;
  fullName: string;
  mode: "register" | "login";
  onEmailChange: (value: string) => void;
  onFullNameChange: (value: string) => void;
  onModeChange: (value: "register" | "login") => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTenantNameChange: (value: string) => void;
  password: string;
  tenantName: string;
}

export function AuthForm(props: AuthFormProps) {
  const isError =
    props.authStatus !== null && !props.authStatus.toLowerCase().startsWith("signed in");

  return (
    <form className="auth-form" onSubmit={props.onSubmit} noValidate>
      {/* Mode switch */}
      <div className="mode-switch">
        <button
          className={props.mode === "register" ? "active" : ""}
          onClick={() => props.onModeChange("register")}
          type="button"
        >
          <UserPlus className="h-4 w-4" />
          Register
        </button>
        <button
          className={props.mode === "login" ? "active" : ""}
          onClick={() => props.onModeChange("login")}
          type="button"
        >
          <LogIn className="h-4 w-4" />
          Login
        </button>
      </div>

      {/* Email */}
      <div className="auth-field">
        <Label htmlFor="auth-email" className="text-xs font-bold uppercase text-muted-foreground">
          Email
        </Label>
        <Input
          id="auth-email"
          autoComplete="email"
          onChange={(e) => props.onEmailChange(e.target.value)}
          placeholder="you@example.com"
          required
          type="email"
          value={props.email}
          className="h-9"
        />
      </div>

      {/* Password */}
      <div className="auth-field">
        <Label
          htmlFor="auth-password"
          className="text-xs font-bold uppercase text-muted-foreground"
        >
          Password
        </Label>
        <Input
          id="auth-password"
          autoComplete={props.mode === "register" ? "new-password" : "current-password"}
          minLength={12}
          onChange={(e) => props.onPasswordChange(e.target.value)}
          placeholder={props.mode === "register" ? "Min. 12 characters" : "Password"}
          required
          type="password"
          value={props.password}
          className="h-9"
        />
        {props.mode === "register" ? <p className="field-hint">Minimum 12 characters</p> : null}
      </div>

      {/* Register-only fields */}
      {props.mode === "register" ? (
        <>
          <div className="auth-field">
            <Label
              htmlFor="auth-name"
              className="text-xs font-bold uppercase text-muted-foreground"
            >
              Full name
            </Label>
            <Input
              id="auth-name"
              autoComplete="name"
              onChange={(e) => props.onFullNameChange(e.target.value)}
              placeholder="Your full name"
              value={props.fullName}
              className="h-9"
            />
          </div>
          <div className="auth-field">
            <Label
              htmlFor="auth-workspace"
              className="text-xs font-bold uppercase text-muted-foreground"
            >
              Workspace
            </Label>
            <Input
              id="auth-workspace"
              onChange={(e) => props.onTenantNameChange(e.target.value)}
              placeholder="Your team or company"
              value={props.tenantName}
              className="h-9"
            />
          </div>
        </>
      ) : null}

      <Button className="w-full" disabled={props.authLoading} type="submit">
        {props.authLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : props.mode === "register" ? (
          <UserPlus className="h-4 w-4" />
        ) : (
          <LogIn className="h-4 w-4" />
        )}
        {props.mode === "register" ? "Create account" : "Sign in"}
      </Button>

      {props.authStatus ? (
        <Badge
          variant={isError ? "destructive" : "success"}
          className="w-full justify-center py-1.5 text-xs"
        >
          {props.authStatus}
        </Badge>
      ) : null}
    </form>
  );
}

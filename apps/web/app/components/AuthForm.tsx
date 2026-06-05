"use client";

import type { FormEvent } from "react";
import { Loader2, LogIn, ShieldCheck, UserPlus } from "lucide-react";

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
  return (
    <form className="auth-form" onSubmit={props.onSubmit}>
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
      <input
        autoComplete="email"
        onChange={(event) => props.onEmailChange(event.target.value)}
        placeholder="Email address"
        required
        type="email"
        value={props.email}
      />
      <div className="auth-field">
        <input
          autoComplete={props.mode === "register" ? "new-password" : "current-password"}
          minLength={12}
          onChange={(event) => props.onPasswordChange(event.target.value)}
          placeholder="Password"
          required
          type="password"
          value={props.password}
        />
        {props.mode === "register" ? <p className="field-hint">Minimum 12 characters</p> : null}
      </div>
      {props.mode === "register" ? (
        <>
          <input
            autoComplete="name"
            onChange={(event) => props.onFullNameChange(event.target.value)}
            placeholder="Full name"
            value={props.fullName}
          />
          <input
            onChange={(event) => props.onTenantNameChange(event.target.value)}
            placeholder="Workspace name"
            value={props.tenantName}
          />
        </>
      ) : null}
      <button className="primary-button w-full" disabled={props.authLoading} type="submit">
        {props.authLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ShieldCheck className="h-4 w-4" />
        )}
        {props.mode === "register" ? "Create account" : "Sign in"}
      </button>
      {props.authStatus ? <p className="status-copy">{props.authStatus}</p> : null}
    </form>
  );
}

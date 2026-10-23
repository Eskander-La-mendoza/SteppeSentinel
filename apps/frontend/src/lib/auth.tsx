"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";

export type UserRole = "ADMIN" | "CLIENT";
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await api<{ user: AuthUser }>("/auth/me");
      setUser(response.user);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) setUser(null);
      else throw error;
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh().catch(() => setLoading(false)); }, [refresh]);
  useEffect(() => {
    const unauthorized = () => setUser(null);
    window.addEventListener("steppe-sentinel:unauthorized", unauthorized);
    return () => window.removeEventListener("steppe-sentinel:unauthorized", unauthorized);
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    refresh,
    login: async (email, password) => {
      const response = await api<{ user: AuthUser }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      setUser(response.user);
    },
    register: async (name, email, password) => {
      const response = await api<{ user: AuthUser }>("/auth/register", { method: "POST", body: JSON.stringify({ name, email, password }) });
      setUser(response.user);
    },
    logout: async () => {
      try { await api<void>("/auth/logout", { method: "POST" }); }
      finally { setUser(null); }
    }
  }), [loading, refresh, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}

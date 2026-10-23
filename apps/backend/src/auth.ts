import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { pool } from "./db.js";
import { env } from "./env.js";

export type UserRole = "ADMIN" | "CLIENT";
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
}

const COOKIE_NAME = "steppe_sentinel_session";
const SESSION_DAYS = 30;
const KEY_LENGTH = 64;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function derive(password: string, salt: Buffer, options = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { ...options, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, n, r, p, saltValue, hashValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64url");
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, Buffer.from(saltValue, "base64url"), { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function cookieToken(req: Request) {
  const cookies = String(req.headers.cookie ?? "").split(";");
  for (const cookie of cookies) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === COOKIE_NAME) return decodeURIComponent(value.join("="));
  }
  return null;
}

export function publicUser(row: any): AuthUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    isActive: Boolean(row.is_active ?? row.isActive),
    createdAt: row.created_at ?? row.createdAt
  };
}

export async function createSession(req: Request, res: Response, userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await pool.query(
    "INSERT INTO auth_sessions (user_id,token_hash,expires_at,user_agent,ip_address) VALUES ($1,$2,$3,$4,$5)",
    [userId, hashToken(token), expiresAt, String(req.headers["user-agent"] ?? "").slice(0, 500), req.ip]
  );
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", secure: env.COOKIE_SECURE, path: "/", expires: expiresAt });
}

export async function destroySession(req: Request, res: Response) {
  const token = cookieToken(req);
  if (token) await pool.query("DELETE FROM auth_sessions WHERE token_hash=$1", [hashToken(token)]);
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "lax", secure: env.COOKIE_SECURE, path: "/" });
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    const token = cookieToken(req);
    if (!token) return void res.status(401).json({ code: "AUTH_REQUIRED", message: "Требуется вход в систему" });
    const result = await pool.query(
      `SELECT u.id,u.name,u.email,u.role,u.is_active,u.created_at,s.id AS session_id
       FROM auth_sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>now()`,
      [hashToken(token)]
    );
    const row = result.rows[0];
    if (!row || !row.is_active) {
      if (row?.session_id) await pool.query("DELETE FROM auth_sessions WHERE id=$1", [row.session_id]);
      res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "lax", secure: env.COOKIE_SECURE, path: "/" });
      return void res.status(401).json({ code: "SESSION_INVALID", message: "Сессия недействительна или пользователь заблокирован" });
    }
    res.locals.user = publicUser(row);
    void pool.query("UPDATE auth_sessions SET last_used_at=now() WHERE id=$1 AND last_used_at<now()-interval '15 minutes'", [row.session_id]).catch(() => undefined);
    next();
  } catch (error) { next(error); }
};

export const requireAdmin: RequestHandler = (_req, res, next) => {
  if ((res.locals.user as AuthUser | undefined)?.role !== "ADMIN") return void res.status(403).json({ code: "ADMIN_REQUIRED", message: "Доступ разрешён только администратору" });
  next();
};

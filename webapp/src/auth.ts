import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { APP_PASSWORD, SESSION_SECRET } from "./config";

const COOKIE = "ajs_session";
const MAX_AGE = 30 * 24 * 3600;

function sign(value: string): string {
  return createHmac("sha256", `ajs:${SESSION_SECRET}`).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function passwordMatches(input: string): boolean {
  return APP_PASSWORD.length > 0 && safeEqual(sign(input), sign(APP_PASSWORD));
}

export function startSession(c: Context) {
  const expires = String(Math.floor(Date.now() / 1000) + MAX_AGE);
  setCookie(c, COOKIE, `${expires}.${sign(expires)}`, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https",
    sameSite: "Lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export function endSession(c: Context) {
  deleteCookie(c, COOKIE, { path: "/" });
}

export function isAuthed(c: Context): boolean {
  const raw = getCookie(c, COOKIE);
  if (!raw || !APP_PASSWORD) return false;
  const [expires, sig] = raw.split(".");
  if (!expires || !sig || !safeEqual(sig, sign(expires))) return false;
  return Number(expires) * 1000 > Date.now();
}

export async function requireAuth(c: Context, next: Next) {
  if (!APP_PASSWORD) return c.json({ error: "APP_PASSWORD is not set on the server." }, 503);
  if (!isAuthed(c)) return c.json({ error: "Not signed in" }, 401);
  await next();
}

import { createHmac, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";

const ACCESS_COOKIE_PREFIX = "premiere_access_";
const HOST_COOKIE_PREFIX = "premiere_host_";
const COOKIE_LIFETIME_SECONDS = 12 * 60 * 60;

type SignedPayload = {
  room: string;
  exp: number;
};

function getCookieSecret(): string {
  const roomCookieSecret = process.env.ROOM_COOKIE_SECRET;
  if (process.env.NODE_ENV === "production") {
    if (!roomCookieSecret) {
      throw new Error("ROOM_COOKIE_SECRET is required in production");
    }
    return roomCookieSecret;
  }

  return (
    roomCookieSecret ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "local-dev-fallback-secret"
  );
}

function sanitizeRoom(room: string): string {
  return room.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function sign(value: string): string {
  return createHmac("sha256", getCookieSecret()).update(value).digest("hex");
}

function encodePayload(payload: SignedPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(encoded: string): SignedPayload | null {
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as Partial<SignedPayload>;
    if (
      typeof parsed.room !== "string" ||
      typeof parsed.exp !== "number" ||
      !Number.isFinite(parsed.exp)
    ) {
      return null;
    }
    return {
      room: sanitizeRoom(parsed.room),
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

function buildToken(payload: SignedPayload): string {
  const encoded = encodePayload(payload);
  return `${encoded}.${sign(encoded)}`;
}

function verifyToken(token: string, room: string): boolean {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) {
    return false;
  }

  const expected = sign(encoded);
  if (expected.length !== signature.length) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(signature, "utf8");
  if (!timingSafeEqual(expectedBuffer, actualBuffer)) {
    return false;
  }

  const payload = decodePayload(encoded);
  if (!payload) {
    return false;
  }

  if (payload.room !== sanitizeRoom(room)) {
    return false;
  }

  return payload.exp > Date.now();
}

function cookieName(prefix: string, room: string): string {
  return `${prefix}${sanitizeRoom(room)}`;
}

export function getAccessCookieName(room: string): string {
  return cookieName(ACCESS_COOKIE_PREFIX, room);
}

export function getHostCookieName(room: string): string {
  return cookieName(HOST_COOKIE_PREFIX, room);
}

export function createRoomAccessToken(room: string): string {
  return buildToken({
    room: sanitizeRoom(room),
    exp: Date.now() + COOKIE_LIFETIME_SECONDS * 1000,
  });
}

export function createHostToken(room: string): string {
  return buildToken({
    room: sanitizeRoom(room),
    exp: Date.now() + COOKIE_LIFETIME_SECONDS * 1000,
  });
}

export function hasValidAccessCookie(
  cookieValue: string | undefined,
  room: string,
): boolean {
  if (!cookieValue) {
    return false;
  }
  return verifyToken(cookieValue, room);
}

export function hasRequestRoomAccess(request: NextRequest, room: string): boolean {
  const cookie = request.cookies.get(getAccessCookieName(room))?.value;
  return hasValidAccessCookie(cookie, room);
}

export function hasRequestHostAccess(request: NextRequest, room: string): boolean {
  const cookie = request.cookies.get(getHostCookieName(room))?.value;
  return hasValidAccessCookie(cookie, room);
}

export function createCookieConfig(maxAgeSeconds: number = COOKIE_LIFETIME_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../lib/env.js";
import { HttpError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";

const SESSION_COOKIE = "dataroom_session";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

type SessionPayload = {
  sub: string;
  email: string;
};

export function signSession(user: AuthUser) {
  return jwt.sign({ sub: user.id, email: user.email } satisfies SessionPayload, env.JWT_SECRET, {
    expiresIn: "7d"
  });
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production"
  });
}

function readBearer(req: Request) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

async function resolveUser(req: Request): Promise<AuthUser | undefined> {
  const token = req.cookies?.[SESSION_COOKIE] ?? readBearer(req);
  if (!token) return undefined;

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as SessionPayload;
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, name: true }
    });
    return user ?? undefined;
  } catch {
    return undefined;
  }
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  req.user = await resolveUser(req);
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new HttpError(401, "Sign in to continue"));
  }
  return next();
}

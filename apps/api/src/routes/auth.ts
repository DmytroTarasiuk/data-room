import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { asyncHandler, HttpError, parseBody } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { clearSessionCookie, setSessionCookie, signSession } from "../middleware/auth.js";

const router = Router();

const authSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  password: z.string().min(8)
});

const registerSchema = authSchema.extend({
  name: z.string().trim().min(2).max(80)
});

function serializeUser(user: { id: string; email: string; name: string }) {
  return {
    id: user.id,
    email: user.email,
    name: user.name
  };
}

router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const input = parseBody(registerSchema, req.body);
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new HttpError(409, "An account with this email already exists");
    }

    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash
      },
      select: { id: true, email: true, name: true }
    });

    setSessionCookie(res, signSession(user));
    res.status(201).json({ user: serializeUser(user) });
  })
);

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const input = parseBody(authSchema, req.body);
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user) {
      throw new HttpError(401, "Email or password is incorrect");
    }

    const ok = await bcrypt.compare(input.password, user.passwordHash);
    if (!ok) {
      throw new HttpError(401, "Email or password is incorrect");
    }

    const sessionUser = serializeUser(user);
    setSessionCookie(res, signSession(sessionUser));
    res.json({ user: sessionUser });
  })
);

router.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.status(204).send();
});

router.get("/me", (req, res) => {
  res.json({ user: req.user ?? null });
});

export { router as authRouter };

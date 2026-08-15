import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { env } from "./lib/env.js";
import { errorHandler } from "./lib/http.js";
import { optionalAuth } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { dataRoomsRouter } from "./routes/dataRooms.js";
import { filesRouter } from "./routes/files.js";
import { foldersRouter } from "./routes/folders.js";
import { sharesRouter } from "./routes/shares.js";

const allowedOrigins = env.WEB_ORIGIN.split(",").map((origin) => origin.trim());

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} is not allowed`));
      },
      credentials: true
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(optionalAuth);

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/data-rooms", dataRoomsRouter);
  app.use("/api", foldersRouter);
  app.use("/api", filesRouter);
  app.use("/api/shares", sharesRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: { message: "Route not found" } });
  });

  app.use(errorHandler);

  return app;
}

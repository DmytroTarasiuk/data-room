import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../apps/api/src/app";

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

const app = createApp() as unknown as NodeHandler;

function normalizeVercelRewriteUrl(req: IncomingMessage) {
  const rawUrl = req.url ?? "/";
  const host = req.headers.host ?? "localhost";
  const parsed = new URL(rawUrl, `https://${host}`);
  const rewrittenPath = parsed.searchParams.get("path");

  if (rewrittenPath && (parsed.pathname === "/api" || parsed.pathname === "/api/")) {
    parsed.searchParams.delete("path");
    const query = parsed.searchParams.toString();
    const cleanPath = rewrittenPath.startsWith("/") ? rewrittenPath.slice(1) : rewrittenPath;
    return `/api/${cleanPath}${query ? `?${query}` : ""}`;
  }

  if (parsed.pathname === "/api" || parsed.pathname.startsWith("/api/")) {
    return rawUrl;
  }

  const normalizedPath = parsed.pathname.startsWith("/") ? parsed.pathname : `/${parsed.pathname}`;
  return `/api${normalizedPath}${parsed.search}`;
}

export default function handler(req: IncomingMessage, res: ServerResponse) {
  req.url = normalizeVercelRewriteUrl(req);
  app(req, res);
}

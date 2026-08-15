import type { IncomingMessage, ServerResponse } from "node:http";

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

let appPromise: Promise<NodeHandler> | undefined;

async function getApp() {
  appPromise ??= import("../apps/api/src/app.js").then(({ createApp }) => createApp() as unknown as NodeHandler);
  return appPromise;
}

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

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();
  req.url = normalizeVercelRewriteUrl(req);
  app(req, res);
}

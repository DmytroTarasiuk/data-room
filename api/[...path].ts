import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../apps/api/src/app";

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

const app = createApp() as unknown as NodeHandler;

function withApiPrefix(url = "/") {
  const [pathname = "/", query] = url.split("?");
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;

  if (normalizedPath === "/api" || normalizedPath.startsWith("/api/")) {
    return url;
  }

  const prefixedPath = `/api${normalizedPath}`;
  return query ? `${prefixedPath}?${query}` : prefixedPath;
}

export default function handler(req: IncomingMessage, res: ServerResponse) {
  req.url = withApiPrefix(req.url);
  app(req, res);
}

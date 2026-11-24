import path from "node:path";
import type express from "express";

const forwardedPrefix = "x-forwarded-prefix";
// Only for Home Assistant versions older than 2026.12, newer ones also send
// X-Forwarded-Prefix. See https://github.com/home-assistant/core/pull/193747
const ingressPath = "x-ingress-path";

// Both headers carry the path prefix that the proxy removed from the URL.
export function supportProxyPrefix(
  req: express.Request,
  _: express.Response,
  next: express.NextFunction,
) {
  const forwarded = req.header(forwardedPrefix);
  const prefix = forwarded || req.header(ingressPath);
  if (!prefix) {
    return next();
  }
  let baseUrl = buildPath(prefix, req.baseUrl);
  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }
  // Older versions required X-Forwarded-Prefix to still be in the URL, so proxies
  // set up that way keep working.
  const url =
    forwarded && req.url.startsWith(`${baseUrl}/`)
      ? req.url.slice(baseUrl.length)
      : buildPath(req.url);
  req.baseUrl = baseUrl;
  req.originalUrl = `${baseUrl}${url}`;
  req.url = url;
  next();
}

function buildPath(...paths: string[]): string {
  let result = path.posix.join(...paths);
  if (!result.startsWith("/")) {
    result = `/${result}`;
  }
  return result;
}

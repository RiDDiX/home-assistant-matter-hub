import path from "node:path";
import type express from "express";

const ingressPath = "x-ingress-path";
const forwardedPrefix = "x-forwarded-prefix";

export function supportIngress(
  req: express.Request,
  _: express.Response,
  next: express.NextFunction,
) {
  // X-Ingress-Path is only for Home Assistant versions older than 2026.12, newer
  // ones send X-Forwarded-Prefix too, which supportProxyLocation applies.
  // See https://github.com/home-assistant/core/pull/193747
  if (req.header(forwardedPrefix) || !(ingressPath in req.headers)) {
    return next();
  }
  const prefix = req.header(ingressPath);
  if (!prefix) {
    return next();
  }
  const baseUrl = buildPath(prefix, req.baseUrl);
  req.baseUrl = baseUrl;
  req.originalUrl = buildPath(baseUrl, req.url);
  req.url = buildPath(req.url);
  next();
}

export function supportProxyLocation(
  req: express.Request,
  _: express.Response,
  next: express.NextFunction,
) {
  if (!(forwardedPrefix in req.headers)) {
    return next();
  }
  const prefix = req.header(forwardedPrefix);
  if (!prefix) {
    return next();
  }
  let baseUrl = buildPath(prefix, req.baseUrl);
  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }
  // Home Assistant ingress removes the prefix from the URL, other proxies may
  // keep it.
  const url = req.url.startsWith(`${baseUrl}/`)
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

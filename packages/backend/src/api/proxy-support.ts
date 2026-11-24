import path from "node:path";
import type express from "express";
import type { BetterLogger } from "../core/app/logger.js";

const forwardedPrefix = "x-forwarded-prefix";
// Home Assistant ingress sends this, X-Forwarded-Prefix is proposed to replace
// it. See https://github.com/home-assistant/core/pull/193747
const ingressPath = "x-ingress-path";

// Both headers carry the path prefix that the proxy removed from the URL.
export function supportProxyPrefix(log: BetterLogger): express.RequestHandler {
  let warned = false;
  return (req, res, next) => {
    const forwarded = req.header(forwardedPrefix);
    const prefix = forwarded || req.header(ingressPath);
    if (!prefix) {
      return next();
    }
    // A backslash or tab can make the base href another origin, a comma is two values.
    if (!/^[\w.~%/-]+$/.test(prefix)) {
      res
        .status(400)
        .contentType("text/plain")
        .send(
          "X-Forwarded-Prefix or X-Ingress-Path must be a plain path like /hamh",
        );
      return;
    }
    const baseUrl = path.posix
      .join("/", prefix, req.baseUrl)
      .replace(/\/$/, "");
    // Removing a prefix without its trailing slash can leave two slashes.
    let url = req.url.replace(/^\/+/, "/");
    // Deprecated: older versions required X-Forwarded-Prefix to still be in the
    // URL. A sub-path like /api is ambiguous here, as it is also a route of ours.
    // To remove it, also remove shouldHandle in websocket-api.ts.
    if (forwarded && baseUrl && url.startsWith(`${baseUrl}/`)) {
      url = url.slice(baseUrl.length);
      if (!warned) {
        warned = true;
        log.warn(
          "A reverse proxy sends X-Forwarded-Prefix but keeps the prefix in the URL. This is deprecated and may stop working in a future version. Remove the prefix from the URL in the proxy, or use --http-base-path instead of the header. See https://riddix.github.io/home-assistant-matter-hub/guides/reverse-proxy",
        );
      }
    }
    req.baseUrl = baseUrl;
    req.originalUrl = `${baseUrl}${url}`;
    req.url = url;
    next();
  };
}

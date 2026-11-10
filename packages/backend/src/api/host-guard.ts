import type { IncomingHttpHeaders } from "node:http";
import net from "node:net";
import type express from "express";
import AccessControl from "express-ip-access-control";

// After a DNS rebind a page can set these itself, so the headers alone prove
// nothing. Only a proxy on loopback or the HA supervisor network is trusted.
const trustedProxies = ["127.0.0.0/8", "::1", "172.30.32.0/23"];
const proxyHeaders = [
  "x-ingress-path",
  "x-forwarded-prefix",
  "x-forwarded-host",
  "x-forwarded-for",
];
const localSuffixes = [
  ".local",
  ".localhost",
  ".home.arpa",
  ".lan",
  ".internal",
  ".fritz.box",
];

export function crossSiteReason(
  headers: IncomingHttpHeaders,
  allowedHosts: string[],
  remoteAddress?: string,
): "host" | "origin" | undefined {
  const host = normalizeHost(headers.host);
  if (!host || !hostAllowed(hostName(host), allowedHosts)) {
    return "host";
  }
  const origin = headers.origin;
  if (
    origin === undefined ||
    (proxyHeaders.some((name) => name in headers) &&
      AccessControl.ipMatch(remoteAddress ?? "", trustedProxies))
  ) {
    return undefined;
  }
  try {
    if (origin === "null") {
      return "origin";
    }
    const originHost = new URL(origin).host;
    return originHost === host || listed(hostName(originHost), allowedHosts)
      ? undefined
      : "origin";
  } catch {
    return "origin";
  }
}

export function hostGuard(allowedHosts: string[]): express.RequestHandler {
  return (req, res, next) => {
    const reason = crossSiteReason(
      req.headers,
      allowedHosts,
      req.socket.remoteAddress,
    );
    if (!reason) {
      return next();
    }
    res
      .status(403)
      .type("text")
      .send(
        reason === "host"
          ? `Host ${req.headers.host ?? ""} is not allowed, add it with --http-allowed-hosts`
          : "Cross-site request blocked",
      );
  };
}

function normalizeHost(host: string | undefined): string | undefined {
  return (
    host
      ?.toLowerCase()
      .replace(/\.(:\d+)?$/, "$1")
      .replace(/:(80|443)$/, "") || undefined
  );
}

function hostName(host: string): string {
  if (host.startsWith("[")) {
    return host.slice(1, host.indexOf("]"));
  }
  return host.replace(/:\d+$/, "");
}

function hostAllowed(name: string, allowedHosts: string[]): boolean {
  if (
    net.isIP(name) ||
    name === "localhost" ||
    !name.includes(".") ||
    localSuffixes.some((suffix) => name.endsWith(suffix))
  ) {
    return true;
  }
  return listed(name, allowedHosts);
}

function listed(name: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((entry) => {
    const allowed = entry.toLowerCase().replace(/:\d+$/, "");
    return allowed.startsWith("*.")
      ? name.endsWith(allowed.slice(1))
      : name === allowed;
  });
}

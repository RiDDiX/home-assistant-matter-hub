import type { IncomingHttpHeaders } from "node:http";
import net from "node:net";
import type express from "express";
import AccessControl from "express-ip-access-control";

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
  // HA ingress forwards whatever name HA is reached by. Only the add-on's
  // Supervisor can reach us from 172.30.32.2, and it authenticates the user.
  if (
    (process.env.SUPERVISOR_TOKEN || process.env.HASSIO_TOKEN) &&
    "x-ingress-path" in headers &&
    AccessControl.ipMatch(remoteAddress ?? "", ["172.30.32.2"])
  ) {
    return undefined;
  }
  const host = normalizeHost(headers.host);
  const name = host && hostName(host);
  if (!name || !hostAllowed(name, allowedHosts)) {
    return "host";
  }
  const origin = headers.origin;
  // A same-host reverse proxy adds X-Forwarded-For to cross-site requests too.
  if (origin === undefined) {
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
    res.status(403).type("text").send(crossSiteMessage(reason, req.headers));
  };
}

export function crossSiteMessage(
  reason: "host" | "origin",
  headers: IncomingHttpHeaders,
): string {
  if (reason === "host") {
    return `Host ${headers.host ?? ""} is not allowed, add it with --http-allowed-hosts`;
  }
  try {
    const originHost = new URL(headers.origin ?? "").host;
    if (originHost) {
      return `Origin ${originHost} is not allowed, add it with --http-allowed-hosts`;
    }
  } catch {}
  return "Cross-site request blocked";
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
    const end = host.indexOf("]");
    return end === -1 ? "" : host.slice(1, end);
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

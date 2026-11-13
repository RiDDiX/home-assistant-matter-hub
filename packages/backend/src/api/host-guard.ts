import type { IncomingHttpHeaders } from "node:http";
import net from "node:net";
import type express from "express";
import AccessControl from "express-ip-access-control";
import type { BetterLogger } from "../core/app/logger.js";

const localSuffixes = [
  ".local",
  ".localhost",
  ".home.arpa",
  ".lan",
  ".internal",
  ".fritz.box",
];

// Only the add-on's Supervisor can reach us from 172.30.32.2, and it
// authenticates the user.
export function isSupervisorIngress(
  headers: IncomingHttpHeaders,
  remoteAddress?: string,
): boolean {
  return Boolean(
    (process.env.SUPERVISOR_TOKEN || process.env.HASSIO_TOKEN) &&
      "x-ingress-path" in headers &&
      AccessControl.ipMatch(remoteAddress ?? "", ["172.30.32.2"]),
  );
}

// Decides on the socket address only, forwarding headers are never trusted.
export function ipWhitelist(
  entries: string[],
  log: BetterLogger,
): (remoteAddress: string | undefined) => boolean {
  // Env files can leave whitespace around an entry.
  const valid = entries
    .map((entry) => entry.trim())
    .filter((entry) => {
      const [ip, bits, ...rest] = entry.split("/");
      const version = net.isIP(ip);
      const ok =
        version > 0 &&
        rest.length === 0 &&
        (bits === undefined ||
          (/^\d{1,3}$/.test(bits) &&
            Number(bits) <= (version === 4 ? 32 : 128)));
      if (!ok) {
        log.warn(
          `Ignoring --http-ip-whitelist entry "${entry}", it is neither an IP nor a CIDR`,
        );
      }
      return ok;
    });
  const seen = new Set<string>();
  return (remoteAddress) => {
    const address = remoteAddress ?? "";
    if (AccessControl.ipMatch(address, valid)) {
      return true;
    }
    const message = `Denied ${address || "unknown address"}, not in --http-ip-whitelist`;
    // At most 50 warnings, rotating addresses must not flood the log.
    if (seen.has(address) || seen.size >= 50) {
      log.debug(message);
      return false;
    }
    seen.add(address);
    log.warn(message);
    return false;
  };
}

export function crossSiteReason(
  headers: IncomingHttpHeaders,
  allowedHosts: string[],
  remoteAddress?: string,
): "host" | "origin" | undefined {
  // HA ingress forwards whatever name HA is reached by.
  if (isSupervisorIngress(headers, remoteAddress)) {
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

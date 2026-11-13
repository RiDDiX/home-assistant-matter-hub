import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const entrypoint = fileURLToPath(
  new URL("../addon.docker-entrypoint.sh", import.meta.url),
);

// Options come from OPT_<key> variables. Like bashio, a missing key gives the
// default only when it is non-empty, otherwise "null".
const bashioStub = `
bashio::config() {
  local var="OPT_$1"
  if [ -n "\${!var+x}" ]; then printf '%s\\n' "\${!var}"
  elif [ -n "\${2:-}" ]; then printf '%s\\n' "$2"
  else echo null; fi
}
bashio::config.true() { [ "$(bashio::config "$1")" = "true" ]; }
bashio::log.info() { echo "LOG: $*" >&2; }
bashio::log.warning() { echo "WARN: $*" >&2; }
bashio::addon.version() { echo 1.0.0; }
bashio::addon.ingress_port() { echo 8482; }
`;

describe.skipIf(process.platform === "win32")(
  "addon entrypoint",
  { timeout: 20_000 },
  () => {
    let dir: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "hamh-entrypoint-"));
      writeFileSync(join(dir, "bashio.sh"), bashioStub);
      const bin = join(dir, "home-assistant-matter-hub");
      writeFileSync(
        bin,
        '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\necho "TOKEN=$HAMH_HOME_ASSISTANT_ACCESS_TOKEN"\necho "AUTH=$HAMH_HTTP_AUTH_USERNAME:$HAMH_HTTP_AUTH_PASSWORD"\n',
      );
      chmodSync(bin, 0o755);
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    function run(options: Record<string, string>) {
      const env: Record<string, string> = {
        PATH: `${dir}:${process.env.PATH}`,
        SUPERVISOR_TOKEN: "supervisor-secret",
      };
      for (const [key, value] of Object.entries(options)) {
        env[`OPT_${key}`] = value;
      }
      const result = spawnSync(
        "bash",
        [
          "-c",
          // bashio runs the script with these shell options
          'set -o errexit -o errtrace -o nounset -o pipefail; source "$1"; source "$2"',
          "bash",
          join(dir, "bashio.sh"),
          entrypoint,
        ],
        { env, encoding: "utf8", timeout: 15_000 },
      );
      expect(result.status, result.stderr).toBe(0);
      const lines = result.stdout.split("\n");
      const args = lines.filter(
        (a) => !a.startsWith("TOKEN=") && !a.startsWith("AUTH="),
      );
      const arg = (name: string) =>
        args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
      return {
        url: arg("home-assistant-url"),
        token: lines.find((a) => a.startsWith("TOKEN="))?.slice(6),
        auth: lines.find((a) => a.startsWith("AUTH="))?.slice(5),
        whitelist: args
          .filter((a) => a.startsWith("--http-ip-whitelist="))
          .map((a) => a.slice(20)),
        args,
        stderr: result.stderr,
      };
    }

    it("uses the Supervisor without the option", () => {
      const r = run({});
      expect(r.url).toBe("http://supervisor/core");
      expect(r.token).toBe("supervisor-secret");
    });

    it("uses the Supervisor with an empty token", () => {
      const r = run({ access_token: "", home_assistant_url: "http://ha:1" });
      expect(r.url).toBe("http://supervisor/core");
      expect(r.token).toBe("supervisor-secret");
    });

    it("uses a set token against Core", () => {
      const r = run({ access_token: "user-token" });
      expect(r.url).toBe("http://127.0.0.1:8123");
      expect(r.token).toBe("user-token");
    });

    it("uses a custom url with the token", () => {
      const r = run({
        access_token: "user-token",
        home_assistant_url: "https://ha.local:8443",
      });
      expect(r.url).toBe("https://ha.local:8443");
      expect(r.token).toBe("user-token");
    });

    it("trims whitespace around the token", () => {
      expect(run({ access_token: "  user-token \n" }).token).toBe("user-token");
      expect(run({ access_token: "user-token\n\n" }).token).toBe("user-token");
    });

    it("falls back to the local url when the url option is empty", () => {
      const r = run({ access_token: "user-token", home_assistant_url: "" });
      expect(r.url).toBe("http://127.0.0.1:8123");
    });

    it("trims whitespace around the url", () => {
      const r = run({
        access_token: "user-token",
        home_assistant_url: " https://ha.local:8443 \n",
      });
      expect(r.url).toBe("https://ha.local:8443");
    });

    it("falls back to the local url when the url is only whitespace", () => {
      const r = run({ access_token: "user-token", home_assistant_url: " \n " });
      expect(r.url).toBe("http://127.0.0.1:8123");
    });

    it("keeps the token out of argv", () => {
      const user = run({ access_token: "user-token" });
      expect(user.token).toBe("user-token");
      expect(user.args.join("\n")).not.toContain("user-token");
      const supervisor = run({});
      expect(supervisor.token).toBe("supervisor-secret");
      expect(supervisor.args.join("\n")).not.toContain("supervisor-secret");
    });

    it("never logs the token", () => {
      const r = run({
        access_token: "user-token",
        home_assistant_url: "http://ha:1",
      });
      expect(r.stderr).toContain(
        "LOG: Home Assistant: using the configured access token at http://ha:1",
      );
      expect(r.stderr).not.toContain("user-token");
    });

    const closedWarning =
      "WARN: local_api_password is set but allow_local_access is off, the local API stays closed";
    const openWarning =
      "WARN: Local API: http://127.0.0.1:8482 without a password, every process on this host has full control";

    it("keeps the API to the Supervisor while local access is off", () => {
      for (const options of [{}, { allow_local_access: "false" }]) {
        const r = run(options);
        expect(r.args).toContain("--web-port=8482");
        expect(r.whitelist).toEqual(["172.30.32.2"]);
        expect(r.auth).toBe(":");
        expect(r.args.join("\n")).not.toContain("auth");
        expect(r.stderr).not.toContain("Local API");
        expect(r.stderr).not.toContain(closedWarning);
      }
    });

    it("warns about a password while local access is off", () => {
      const r = run({
        allow_local_access: "false",
        local_api_password: "local-secret",
      });
      expect(r.args).toContain("--web-port=8482");
      expect(r.whitelist).toEqual(["172.30.32.2"]);
      expect(r.auth).toBe(":");
      expect(r.args.join("\n")).not.toContain("local-secret");
      expect(r.stderr).toContain(closedWarning);
      expect(r.stderr).not.toContain("local-secret");
    });

    it("opens the API to loopback without a password", () => {
      for (const password of [undefined, "", "   "]) {
        const r = run({
          allow_local_access: "true",
          ...(password === undefined ? {} : { local_api_password: password }),
        });
        expect(r.args).toContain("--web-port=8482");
        expect(r.whitelist).toEqual(["172.30.32.2", "127.0.0.1", "::1"]);
        expect(r.auth).toBe(":");
        expect(r.stderr).toContain(openWarning);
      }
    });

    it("opens the API to loopback with a local password", () => {
      const r = run({
        allow_local_access: "true",
        local_api_password: "local-secret",
      });
      expect(r.args).toContain("--web-port=8482");
      expect(r.whitelist).toEqual(["172.30.32.2", "127.0.0.1", "::1"]);
      expect(r.auth).toBe("hamh:local-secret");
      expect(r.stderr).not.toContain(openWarning);
      expect(r.args.join("\n")).not.toContain("local-secret");
      expect(r.stderr).toContain(
        "LOG: Local API: http://127.0.0.1:8482 with user name hamh",
      );
      expect(r.stderr).not.toContain("local-secret");
    });
  },
);

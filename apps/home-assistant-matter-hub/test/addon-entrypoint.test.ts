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
bashio::log.info() { echo "LOG: $*" >&2; }
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
        '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\necho "TOKEN=$HAMH_HOME_ASSISTANT_ACCESS_TOKEN"\n',
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
      const args = lines.filter((a) => !a.startsWith("TOKEN="));
      const arg = (name: string) =>
        args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
      return {
        url: arg("home-assistant-url"),
        token: lines.find((a) => a.startsWith("TOKEN="))?.slice(6),
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
  },
);

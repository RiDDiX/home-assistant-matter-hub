import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import yargs, { type ArgumentsCamelCase } from "yargs";
import type { StartOptions } from "./start-options.js";
import { startOptionsBuilder } from "./start-options-builder.js";

function parse(argv: string[]): ArgumentsCamelCase<StartOptions> {
  let options: ArgumentsCamelCase<StartOptions> | undefined;
  yargs(["start", ...argv])
    .strict()
    .command({
      command: "start",
      builder: startOptionsBuilder,
      handler: (args) => {
        options = args;
      },
    })
    .demandCommand()
    .fail((msg, err) => {
      throw err ?? new Error(msg);
    })
    .parse();
  if (!options) throw new Error("start handler did not run");
  return options;
}

describe("startOptionsBuilder env", () => {
  afterEach(() => {
    delete process.env.HAMH_HOME_ASSISTANT_ACCESS_TOKEN;
  });

  it("reads the access token from HAMH_HOME_ASSISTANT_ACCESS_TOKEN", () => {
    const token = "eyJhbGciOi.J9-x_y=/+ --not-a-flag 12345";
    process.env.HAMH_HOME_ASSISTANT_ACCESS_TOKEN = token;
    const options = parse(["--home-assistant-url=http://ha:1"]);
    expect(options["home-assistant-access-token"]).toBe(token);
  });

  it("keeps a numeric looking token a string", () => {
    process.env.HAMH_HOME_ASSISTANT_ACCESS_TOKEN = "0123456789";
    const options = parse(["--home-assistant-url=http://ha:1"]);
    expect(options["home-assistant-access-token"]).toBe("0123456789");
  });

  it("still demands a token without the variable", () => {
    expect(() => parse(["--home-assistant-url=http://ha:1"])).toThrow(
      /home-assistant-access-token/,
    );
  });
});

describe("startOptionsBuilder lists", () => {
  const base = [
    "--home-assistant-url=http://ha:1",
    "--home-assistant-access-token=t",
  ];

  afterEach(() => {
    delete process.env.HAMH_HTTP_IP_WHITELIST;
    delete process.env.HAMH_HTTP_ALLOWED_HOSTS;
  });

  it("splits a comma-separated env var", () => {
    process.env.HAMH_HTTP_IP_WHITELIST = "192.168.1.0/24,172.18.0.0/16,::1";
    expect(parse(base)["http-ip-whitelist"]).toEqual([
      "192.168.1.0/24",
      "172.18.0.0/16",
      "::1",
    ]);
  });

  it("trims spaces around commas", () => {
    process.env.HAMH_HTTP_IP_WHITELIST = " 10.0.0.1 , 10.0.0.2 ,";
    expect(parse(base).httpIpWhitelist).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("turns an empty env var into an empty list", () => {
    process.env.HAMH_HTTP_IP_WHITELIST = "";
    expect(parse(base)["http-ip-whitelist"]).toEqual([]);
  });

  it("keeps repeated flags", () => {
    const options = parse([
      ...base,
      "--http-ip-whitelist=10.0.0.1",
      "--http-ip-whitelist=10.0.0.2,10.0.0.3",
    ]);
    expect(options["http-ip-whitelist"]).toEqual([
      "10.0.0.1",
      "10.0.0.2",
      "10.0.0.3",
    ]);
  });

  it("passes a config file array through", () => {
    const file = path.join(
      os.tmpdir(),
      `hamh-options-${process.pid}-${Date.now()}.json`,
    );
    fs.writeFileSync(
      file,
      JSON.stringify({
        httpIpWhitelist: ["192.168.1.0/24", "172.18.0.0/16"],
        "http-allowed-hosts": ["ha.example.com"],
      }),
    );
    try {
      const options = parse([...base, `--config=${file}`]);
      expect(options["http-ip-whitelist"]).toEqual([
        "192.168.1.0/24",
        "172.18.0.0/16",
      ]);
      expect(options["http-allowed-hosts"]).toEqual(["ha.example.com"]);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("splits allowed hosts the same way", () => {
    process.env.HAMH_HTTP_ALLOWED_HOSTS = "ha.example.com, *.example.org";
    expect(parse(base)["http-allowed-hosts"]).toEqual([
      "ha.example.com",
      "*.example.org",
    ]);
  });
});

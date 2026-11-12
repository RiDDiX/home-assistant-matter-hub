import { afterEach, describe, expect, it } from "vitest";
import yargs from "yargs";
import type { StartOptions } from "./start-options.js";
import { startOptionsBuilder } from "./start-options-builder.js";

function parse(argv: string[]): StartOptions {
  let options: StartOptions | undefined;
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

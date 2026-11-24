import { Environment, type Logger } from "@matter/general";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentBase } from "./environment-base.js";
import { Service } from "./service.js";

// A service whose dispose rejected ended the chain, HomeAssistantClient was
// never disposed and the process lived on without its web server.

class Probe extends Service {
  constructor(
    name: string,
    readonly disposed: string[],
    private readonly fail = false,
  ) {
    super(name);
  }

  override async dispose() {
    this.disposed.push(this.serviceName);
    if (this.fail) throw new Error(`${this.serviceName} broke`);
  }
}

class A extends Probe {}
class B extends Probe {}
class C extends Probe {}

function logger() {
  return { info: vi.fn(), error: vi.fn() } as unknown as Logger & {
    error: ReturnType<typeof vi.fn>;
  };
}

describe("EnvironmentBase dispose", () => {
  it("disposes every service past one that rejects", async () => {
    const log = logger();
    const env = new EnvironmentBase({
      id: "dispose-test",
      log,
      parent: new Environment("dispose-root"),
    });
    const disposed: string[] = [];
    env.set(A, new A("a", disposed));
    env.set(B, new B("b", disposed, true));
    env.set(C, new C("c", disposed));

    await expect(env.dispose()).resolves.toBeUndefined();

    expect(disposed).toEqual(["c", "b", "a"]);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0][0])).toContain("b");
  });
});

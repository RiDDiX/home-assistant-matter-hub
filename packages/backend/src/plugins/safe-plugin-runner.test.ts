import { describe, expect, it } from "vitest";
import { SafePluginRunner } from "./safe-plugin-runner.js";

describe("SafePluginRunner", () => {
  describe("circuit breaker", () => {
    it("should disable plugin after 3 consecutive failures (throws)", async () => {
      const runner = new SafePluginRunner();

      for (let i = 0; i < 3; i++) {
        await runner.run("bad-plugin", "onStart", () => {
          throw new Error(`Failure ${i + 1}`);
        });
      }

      expect(runner.isDisabled("bad-plugin")).toBe(true);
      const state = runner.getState("bad-plugin");
      expect(state.failures).toBe(3);
      expect(state.disabled).toBe(true);
      expect(state.lastError).toContain("Failure 3");
      expect(state.disabledAt).toBeGreaterThan(0);
    });

    it("should skip execution when plugin is disabled", async () => {
      const runner = new SafePluginRunner();
      // Trip the circuit breaker
      for (let i = 0; i < 3; i++) {
        await runner.run("bad-plugin", "op", () => {
          throw new Error("fail");
        });
      }

      let called = false;
      const result = await runner.run("bad-plugin", "op", () => {
        called = true;
        return Promise.resolve("should-not-run");
      });

      expect(called).toBe(false);
      expect(result).toBeUndefined();
    });

    it("should reset failure count on success", async () => {
      const runner = new SafePluginRunner();

      // Two failures
      await runner.run("flaky", "op", () => {
        throw new Error("fail");
      });
      await runner.run("flaky", "op", () => {
        throw new Error("fail");
      });
      expect(runner.getState("flaky").failures).toBe(2);

      // One success resets
      await runner.run("flaky", "op", () => Promise.resolve("ok"));
      expect(runner.getState("flaky").failures).toBe(0);
      expect(runner.isDisabled("flaky")).toBe(false);
    });

    it("should allow manual circuit breaker reset", async () => {
      const runner = new SafePluginRunner();
      for (let i = 0; i < 3; i++) {
        await runner.run("bad", "op", () => {
          throw new Error("fail");
        });
      }
      expect(runner.isDisabled("bad")).toBe(true);

      runner.resetCircuitBreaker("bad");
      expect(runner.isDisabled("bad")).toBe(false);
      expect(runner.getState("bad").failures).toBe(0);
    });
  });

  describe("timeout", () => {
    it("should timeout a hanging plugin", async () => {
      const runner = new SafePluginRunner();

      const result = await runner.run(
        "hanging-plugin",
        "onStart",
        () => new Promise(() => {}), // never resolves
        200, // 200ms timeout
      );

      expect(result).toBeUndefined();
      const state = runner.getState("hanging-plugin");
      expect(state.failures).toBe(1);
      expect(state.lastError).toContain("timed out");
    });

    it("should disable plugin after 3 hangs", async () => {
      const runner = new SafePluginRunner();

      for (let i = 0; i < 3; i++) {
        await runner.run("hang-plugin", "op", () => new Promise(() => {}), 100);
      }

      expect(runner.isDisabled("hang-plugin")).toBe(true);
      expect(runner.getState("hang-plugin").lastError).toContain("timed out");
    });
  });

  describe("sync runner", () => {
    it("should catch sync throws", () => {
      const runner = new SafePluginRunner();
      const result = runner.runSync("sync-bad", "op", () => {
        throw new Error("sync boom");
      });
      expect(result).toBeUndefined();
      expect(runner.getState("sync-bad").failures).toBe(1);
      expect(runner.getState("sync-bad").lastError).toBe("sync boom");
    });

    it("should disable after 3 sync failures", () => {
      const runner = new SafePluginRunner();
      for (let i = 0; i < 3; i++) {
        runner.runSync("sync-bad", "op", () => {
          throw new Error("fail");
        });
      }
      expect(runner.isDisabled("sync-bad")).toBe(true);
    });
  });

  describe("runCleanup (#439 review)", () => {
    it("runs the callback with the breaker open", async () => {
      const runner = new SafePluginRunner();
      for (let i = 0; i < 3; i++) {
        await runner.run("p", "onStart", () => {
          throw new Error("fail");
        });
      }
      expect(runner.isDisabled("p")).toBe(true);

      let ran = false;
      await runner.runCleanup("p", "onShutdown", () => {
        ran = true;
      });
      expect(ran).toBe(true);
    });

    it("never feeds a cleanup failure into the breaker", async () => {
      const runner = new SafePluginRunner();
      await runner.runCleanup("p", "onShutdown", () => {
        throw new Error("cleanup crash");
      });
      expect(runner.getState("p").failures).toBe(0);
      expect(runner.isDisabled("p")).toBe(false);
    });

    it("keeps the breaker state untouched on cleanup success", async () => {
      const runner = new SafePluginRunner();
      await runner.run("p", "op", () => {
        throw new Error("one failure");
      });
      await runner.runCleanup("p", "onShutdown", () => {});
      expect(runner.getState("p").failures).toBe(1);
    });
  });
});

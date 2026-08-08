import type { Connection } from "home-assistant-js-websocket";
import { describe, expect, it, vi } from "vitest";
import { HA_MESSAGE_TIMEOUT_MS, sendHaMessage } from "./send-ha-message.js";

type FakeConnection = Pick<Connection, "sendMessagePromise">;

function fakeConnection(impl: Connection["sendMessagePromise"]): Connection {
  return { sendMessagePromise: impl } as FakeConnection as Connection;
}

describe("sendHaMessage", () => {
  it("resolves with the value returned by the connection", async () => {
    const conn = fakeConnection(vi.fn().mockResolvedValue({ ok: true }));
    await expect(
      sendHaMessage<{ ok: boolean }>(conn, { type: "ping" }),
    ).resolves.toEqual({ ok: true });
  });

  it("passes the message object straight through", async () => {
    const spy = vi.fn().mockResolvedValue([]);
    const conn = fakeConnection(spy);
    await sendHaMessage(conn, { type: "config/entity_registry/list" });
    expect(spy).toHaveBeenCalledWith({ type: "config/entity_registry/list" });
  });

  it("propagates rejections from the underlying call", async () => {
    const conn = fakeConnection(
      vi.fn().mockRejectedValue(new Error("ERR_CONNECTION_LOST")),
    );
    await expect(sendHaMessage(conn, { type: "ping" })).rejects.toThrow(
      "ERR_CONNECTION_LOST",
    );
  });

  it("rejects with a typed timeout error when the call never resolves", async () => {
    const conn = fakeConnection(
      vi.fn().mockImplementation(() => new Promise(() => {})),
    );
    await expect(
      sendHaMessage(conn, { type: "slow/thing" }, 30),
    ).rejects.toThrow("HA message 'slow/thing' timed out after 30ms");
  });

  it("clears the timer when the call resolves in time", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const conn = fakeConnection(vi.fn().mockResolvedValue("fast"));
    await sendHaMessage(conn, { type: "fast/thing" }, 50);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("clears the timer when the call rejects in time", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const conn = fakeConnection(vi.fn().mockRejectedValue(new Error("nope")));
    await expect(sendHaMessage(conn, { type: "bad" }, 50)).rejects.toThrow(
      "nope",
    );
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("exposes a 60s default timeout", () => {
    expect(HA_MESSAGE_TIMEOUT_MS).toBe(60_000);
  });
});

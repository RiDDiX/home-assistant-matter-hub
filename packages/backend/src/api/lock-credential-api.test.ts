import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { LockCredentialStorage } from "../services/storage/lock-credential-storage.js";
import { lockCredentialApi } from "./lock-credential-api.js";

async function request(
  storage: Partial<LockCredentialStorage>,
  method: string,
  path: string,
  body: unknown,
  mappingsOf?: Parameters<typeof lockCredentialApi>[1],
) {
  const app = express();
  app.use(express.json());
  app.use(
    "/locks",
    lockCredentialApi(storage as LockCredentialStorage, mappingsOf),
  );
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${port}/locks/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const stored = {
  entityId: "lock.front",
  pinCodeHash: "aa",
  pinCodeSalt: "bb",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

describe("PUT /:entityId", () => {
  it("checks the PIN against the lock's mapped length bounds", async () => {
    const setCredential = vi.fn().mockResolvedValue(stored);
    const mappingsOf = () => [{ lockPinMinLength: 10, lockPinMaxLength: 12 }];

    const short = await request(
      { setCredential },
      "PUT",
      "lock.front",
      { pinCode: "12345678" },
      mappingsOf,
    );
    expect(short.status).toBe(400);
    expect((await short.json()).error).toContain("between 10 and 12");

    const ok = await request(
      { setCredential },
      "PUT",
      "lock.front",
      { pinCode: "1234567890" },
      mappingsOf,
    );
    expect(ok.status).toBe(200);
    expect(setCredential).toHaveBeenCalledTimes(1);
  });

  it("keeps 4 to 8 digits for an unmapped lock", async () => {
    const setCredential = vi.fn().mockResolvedValue(stored);
    const res = await request({ setCredential }, "PUT", "lock.front", {
      pinCode: "123456789",
    });
    expect(res.status).toBe(400);
    expect(setCredential).not.toHaveBeenCalled();
  });
});

describe("PATCH /:entityId/enabled", () => {
  it("rejects anything but a boolean", async () => {
    const toggleEnabled = vi.fn().mockResolvedValue(stored);
    for (const body of [{}, { enabled: "false" }]) {
      const res = await request(
        { toggleEnabled },
        "PATCH",
        "lock.front/enabled",
        body,
      );
      expect(res.status).toBe(400);
    }
    expect(toggleEnabled).not.toHaveBeenCalled();

    const res = await request(
      { toggleEnabled },
      "PATCH",
      "lock.front/enabled",
      {
        enabled: false,
      },
    );
    expect(res.status).toBe(200);
    expect(toggleEnabled).toHaveBeenCalledWith("lock.front", false);
  });
});

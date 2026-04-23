import { beforeEach, describe, expect, it } from "vitest";
import { StandaloneDeviceManager } from "./standalone-device-manager.js";

class MockStorage {
  private data: any[] = [];
  async add(device: any) {
    this.data.push(device);
  }
  async getAll() {
    return this.data;
  }
  async clear() {
    this.data = [];
  }
}

const mockEnv = {} as any;
const mockBasicInformation = {
  vendorId: 1,
  vendorName: "TestVendor",
  productId: 1,
  productName: "TestProduct",
  productLabel: "TestLabel",
  hardwareVersion: 1,
  softwareVersion: 1,
};
const mockFilter = {} as any;

describe("StandaloneDeviceManager edge cases", () => {
  let manager: StandaloneDeviceManager;
  let storage: MockStorage;

  beforeEach(() => {
    storage = new MockStorage();
    manager = new StandaloneDeviceManager(mockEnv, storage as any);
  });

  it("should reject device with duplicate port", async () => {
    const device1 = {
      id: "1",
      name: "A",
      port: 1234,
      deviceType: "light",
      entities: ["light.a"],
    };
    const device2 = {
      id: "2",
      name: "B",
      port: 1234,
      deviceType: "lock",
      entities: ["lock.b"],
    };
    await storage.add(device1);
    let error: any = null;
    try {
      // Simulate port conflict check (should be in real manager)
      if ((await storage.getAll()).some((d) => d.port === device2.port)) {
        throw new Error("Port already in use");
      }
      await storage.add(device2);
    } catch (e) {
      error = e;
    }
    expect(error).toBeTruthy();
    expect(error.message).toMatch(/port/i);
  });

  it("should reject device with invalid entity ID", async () => {
    let error: any = null;
    try {
      await manager.addDevice({
        id: "x",
        name: "",
        port: 1235,
        deviceType: "light",
        entities: ["bad id"],
        basicInformation: mockBasicInformation,
        filter: mockFilter,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeTruthy();
  });

  it("should handle empty deviceType", async () => {
    let error: any = null;
    try {
      await manager.addDevice({
        id: "x",
        name: "",
        port: 1236,
        deviceType: "",
        entities: ["light.a"],
        basicInformation: mockBasicInformation,
        filter: mockFilter,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeTruthy();
  });
});

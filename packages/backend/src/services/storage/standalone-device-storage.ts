import type { StandaloneDeviceData } from "@home-assistant-matter-hub/common";
import type { StorageContext, SupportedStorageTypes } from "@matter/main";
import { Service } from "../../core/ioc/service.js";
import type { AppStorage } from "./app-storage.js";

export class StandaloneDeviceStorage extends Service {
  private storage!: StorageContext;
  private _devices: StandaloneDeviceData[] = [];

  constructor(private readonly appStorage: AppStorage) {
    super("StandaloneDeviceStorage");
  }

  protected override async initialize() {
    this.storage = this.appStorage.createContext("standalone-devices");
    let deviceIds: string[] | undefined = await this.storage.get("ids", []);
    if (!Array.isArray(deviceIds)) deviceIds = [];
    const devices = await Promise.all(
      deviceIds.map(async (deviceId) =>
        this.storage.get<SupportedStorageTypes | undefined>(deviceId),
      ),
    );
    this._devices = devices
      .filter((d) => d !== undefined)
      .map((d) => d as unknown as StandaloneDeviceData);
  }

  get devices(): ReadonlyArray<StandaloneDeviceData> {
    return this._devices;
  }

  async add(device: StandaloneDeviceData): Promise<void> {
    this._devices.push(device);
    // Serialize device to plain object for storage
    await this.storage.set(device.id, JSON.parse(JSON.stringify(device)));
    await this.saveIds();
  }

  async update(device: StandaloneDeviceData): Promise<void> {
    const idx = this._devices.findIndex((d) => d.id === device.id);
    if (idx !== -1) this._devices[idx] = device;
    // Serialize device to plain object for storage
    await this.storage.set(device.id, JSON.parse(JSON.stringify(device)));
    await this.saveIds();
  }

  async remove(id: string): Promise<void> {
    this._devices = this._devices.filter((d) => d.id !== id);
    await this.storage.delete(id);
    await this.saveIds();
  }

  private async saveIds() {
    await this.storage.set(
      "ids",
      this._devices.map((d) => d.id),
    );
  }
}

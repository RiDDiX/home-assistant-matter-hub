import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type DataNamespace,
  type Environment,
  StorageService,
  VariableService,
} from "@matter/main";
import { CustomStorage } from "./storage/custom-storage.js";

export interface StorageOptions {
  location?: string;
}

export function storage(environment: Environment, options: StorageOptions) {
  const location = resolveStorageLocation(options.location);
  fs.mkdirSync(location, { recursive: true });
  environment.get(VariableService).set("storage.path", location);
  const storageService = environment.get(StorageService);
  storageService.registerDriver({
    id: CustomStorage.driverId,
    async create(namespace: DataNamespace) {
      const driver = new CustomStorage(namespace);
      await driver.initialize();
      return driver;
    },
  });
  storageService.defaultDriver = CustomStorage.driverId;
}

function resolveStorageLocation(storageLocation: string | undefined) {
  const homedir = os.homedir();
  return storageLocation
    ? path.resolve(storageLocation.replace(/^~\//, `${homedir}/`))
    : path.join(homedir, ".home-assistant-matter-hub");
}

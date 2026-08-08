import { ClusterId } from "@home-assistant-matter-hub/common";
import { FileStorageDriver } from "@matter/nodejs";

export class CustomStorage extends FileStorageDriver {
  static readonly driverId = "hamh";

  override async keys(contexts: string[]): Promise<string[]> {
    const key = this.getContextBaseKey(contexts);
    const clusters: string[] = Object.values(ClusterId);
    if (
      key.startsWith("root.parts.aggregator.parts.") &&
      clusters.some((cluster) => key.endsWith(cluster))
    ) {
      return [];
    }
    return await super.keys(contexts);
  }
}

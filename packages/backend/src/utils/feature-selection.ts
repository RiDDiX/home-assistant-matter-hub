import type { ClusterType } from "@matter/main/types";

export type Feature<T extends ClusterType> = T extends {
  features: ClusterType.Features<infer F>;
}
  ? F
  : never;

export type FeatureSelection<T extends ClusterType> =
  | Set<Feature<T>>
  | Feature<T>[];

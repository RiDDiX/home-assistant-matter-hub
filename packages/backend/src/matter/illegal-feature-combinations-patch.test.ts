import { IllegalFeatureCombinations, MatterModel } from "@matter/main/model";
import { describe, expect, it } from "vitest";

// The local @matter/model patch (patches/@matter__model@0.18.*.patch) fixes
// IllegalFeatureCombinations: upstream translated a feature conformance
// "[A | B]" into "illegal when the feature and A and B are all selected",
// which bricked the camera endpoint (ImageControl is "[VDO | SNP]"). The
// correct rule is "illegal when the feature is selected while no disjunct
// is satisfied", flattened across nested ORs so "[A | B | C]" works too.
// These assertions run the real generator, so they fail loudly when an
// install lost the patch. Re-port on every bump until the fix lands upstream.

function illegalFor(clusterName: string) {
  const cluster = [...MatterModel.standard.clusters].find(
    (c) => c.name === clusterName,
  );
  if (!cluster) {
    throw new Error(`cluster ${clusterName} missing from the standard model`);
  }
  return IllegalFeatureCombinations(cluster).illegal;
}

describe("@matter/model feature-or patch", () => {
  it("allows ImageControl next to Video and Snapshot", () => {
    const illegal = illegalFor("CameraAvStreamManagement");
    expect(illegal).not.toContainEqual({
      ICTL: true,
      VDO: true,
      SNP: true,
    });
    expect(illegal).toContainEqual({
      ICTL: true,
      VDO: false,
      SNP: false,
    });
  });

  it("flattens a three way disjunct instead of dropping it", () => {
    const illegal = illegalFor("CameraAvSettingsUserLevelManagement");
    expect(illegal).toContainEqual({
      MPRESETS: true,
      MPAN: false,
      MTILT: false,
      MZOOM: false,
    });
  });
});

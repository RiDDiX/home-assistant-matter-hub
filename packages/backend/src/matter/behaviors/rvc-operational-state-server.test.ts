import { RvcOperationalState } from "@matter/main/clusters/rvc-operational-state";
import { describe, expect, it } from "vitest";
import { makeRvcOperationalError } from "./rvc-operational-state-server.js";

const { ErrorState } = RvcOperationalState;

describe("makeRvcOperationalError", () => {
  it("omits error details when there is no error", () => {
    expect(makeRvcOperationalError(ErrorState.NoError)).toEqual({
      errorStateId: ErrorState.NoError,
    });
  });

  it("keeps error details for real error states", () => {
    expect(makeRvcOperationalError(ErrorState.Stuck)).toEqual({
      errorStateId: ErrorState.Stuck,
      errorStateDetails: "Stuck",
    });
  });
});

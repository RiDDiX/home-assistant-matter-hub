import { describe, expect, it } from "vitest";
import { toUpdateCheckResponse } from "./system-api.js";

describe("toUpdateCheckResponse", () => {
  const base = {
    tag_name: "v2.0.47",
    html_url: "https://example.com/releases/v2.0.47",
    published_at: "2026-06-19T00:00:00Z",
  };

  it("keeps the full release body, no truncation", () => {
    const body = "x".repeat(2000);
    const res = toUpdateCheckResponse("2.0.46", { ...base, body }, "Docker");
    expect(res.releaseNotes).toBe(body);
  });

  it("maps an empty body to undefined", () => {
    const res = toUpdateCheckResponse(
      "2.0.46",
      { ...base, body: "" },
      "Docker",
    );
    expect(res.releaseNotes).toBeUndefined();
  });

  it("flags an update and strips the v prefix when versions differ", () => {
    const res = toUpdateCheckResponse("2.0.46", base, "Docker");
    expect(res.latestVersion).toBe("2.0.47");
    expect(res.updateAvailable).toBe(true);
  });

  it("does not flag an update on the latest version", () => {
    const res = toUpdateCheckResponse("2.0.47", base, "Docker");
    expect(res.updateAvailable).toBe(false);
  });
  it("does not offer an older stable to an alpha build", () => {
    expect(
      toUpdateCheckResponse(
        "2.1.0-alpha.949",
        { ...base, tag_name: "v2.0.59" },
        "Docker",
      ).updateAvailable,
    ).toBe(false);
  });

  it("offers the stable release of the same version to its alpha", () => {
    expect(
      toUpdateCheckResponse(
        "2.1.0-alpha.949",
        { ...base, tag_name: "v2.1.0" },
        "Docker",
      ).updateAvailable,
    ).toBe(true);
  });

  it("does not flag a downgrade", () => {
    expect(
      toUpdateCheckResponse("2.0.48", base, "Docker").updateAvailable,
    ).toBe(false);
  });
});

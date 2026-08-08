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
});

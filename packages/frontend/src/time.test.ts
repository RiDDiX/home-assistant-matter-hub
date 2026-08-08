import { describe, expect, it } from "vitest";
import { timeAgo } from "./time.ts";

describe("timeAgo", () => {
  const now = new Date("2026-06-17T12:00:00Z").getTime();

  it("formats seconds, minutes, hours and days", () => {
    expect(timeAgo("2026-06-17T11:59:30Z", now)).toBe("30s ago");
    expect(timeAgo("2026-06-17T11:45:00Z", now)).toBe("15m ago");
    expect(timeAgo("2026-06-17T09:00:00Z", now)).toBe("3h ago");
    expect(timeAgo("2026-06-15T12:00:00Z", now)).toBe("2d ago");
  });

  it("returns empty for invalid or future times", () => {
    expect(timeAgo("not-a-date", now)).toBe("");
    expect(timeAgo("2026-06-17T13:00:00Z", now)).toBe("");
  });
});

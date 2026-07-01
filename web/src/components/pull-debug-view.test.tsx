// Pin the zone so the local-time assertions are deterministic regardless of where the suite runs.
// Must be set before any Date/Intl call resolves a zone.
process.env.TZ = "Asia/Tokyo";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DebugDataView } from "./pull-debug-view";

afterEach(cleanup);

describe("DebugDataView timestamps (#426)", () => {
  it("renders ISO-8601 UTC timestamps in the local zone with a zone label", () => {
    // 05:30 UTC is 14:30 in Asia/Tokyo (+09:00).
    render(
      <DebugDataView
        data={{ pull_row: { created_at: "2026-07-01T05:30:00Z" } }}
      />,
    );
    const cell = screen.getByText(/2026-07-01 14:30:00/);
    // Local time, not the UTC source, and tagged with a zone (TZ name or offset).
    expect(cell.textContent).toMatch(/^2026-07-01 14:30:00 \S+$/);
    expect(cell.textContent).not.toContain("05:30");
    // The original UTC string is preserved on hover for exact inspection.
    expect(cell.getAttribute("title")).toBe("2026-07-01T05:30:00Z");
  });

  it("converts git dates given as ISO offsets to the same local zone", () => {
    // 23:30+09:00 is the same instant as 14:30 UTC → 23:30 in Asia/Tokyo.
    render(
      <DebugDataView data={{ git: { date: "2026-07-01T14:30:00+00:00" } }} />,
    );
    const cell = screen.getByText(/2026-07-01 23:30:00/);
    expect(cell.getAttribute("title")).toBe("2026-07-01T14:30:00+00:00");
  });

  it("converts every timestamp when several appear in the dump", () => {
    render(
      <DebugDataView
        data={{
          issue_row: {
            created_at: "2026-07-01T05:30:00Z",
            updated_at: "2026-07-01T06:30:00Z",
          },
        }}
      />,
    );
    expect(screen.getByText(/2026-07-01 14:30:00/)).toBeTruthy();
    expect(screen.getByText(/2026-07-01 15:30:00/)).toBeTruthy();
  });

  it("renders an instant on local midnight as 00:00:00, never 24:00:00", () => {
    // 15:00 UTC is 00:00 the next day in Asia/Tokyo (+09:00). `hour12: false` can resolve to the
    // h24 cycle in some locales and render this as `24:00:00`; `hourCycle: "h23"` keeps it 00:00:00.
    render(
      <DebugDataView
        data={{ pull_row: { created_at: "2026-07-01T15:00:00Z" } }}
      />,
    );
    expect(screen.getByText(/^2026-07-02 00:00:00 \S+$/)).toBeTruthy();
    expect(screen.queryByText(/24:00:00/)).toBeNull();
  });

  it("leaves non-instant strings (no zone designator, plain text) untouched", () => {
    render(
      <DebugDataView
        data={{
          pull_row: { head_ref: "feature", note: "2026-07-01 (no time)" },
        }}
      />,
    );
    expect(screen.getByText("feature")).toBeTruthy();
    expect(screen.getByText("2026-07-01 (no time)")).toBeTruthy();
  });
});

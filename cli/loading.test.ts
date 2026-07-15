import { describe, expect, test, vi } from "vitest";
import { withLoading } from "./loading.ts";

describe("withLoading", () => {
  test("starts immediately, animates while waiting, and clears before returning", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });

    const result = withLoading("Scanning worktrees...", () => pending, {
      enabled: true,
      intervalMs: 10,
      write: (text) => writes.push(text),
    });

    expect(writes).toEqual(["\r⠋ Scanning worktrees..."]);
    await vi.advanceTimersByTimeAsync(10);
    expect(writes.at(-1)).toBe("\r⠙ Scanning worktrees...");

    resolve("planned");
    await expect(result).resolves.toBe("planned");
    expect(writes.at(-1)).toBe("\r\u001b[2K");

    const writeCount = writes.length;
    await vi.advanceTimersByTimeAsync(20);
    expect(writes).toHaveLength(writeCount);
    vi.useRealTimers();
  });
});

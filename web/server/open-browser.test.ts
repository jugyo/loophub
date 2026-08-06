import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake child process for the scripted opener spawn; nothing here should reach a real browser.
class FakeChild extends EventEmitter {
  unref = vi.fn();
}

const spawned = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[] }>,
  children: [] as Array<{ emit: (event: string, arg: unknown) => boolean }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[]) => {
      spawned.calls.push({ command, args });
      const child = new FakeChild();
      spawned.children.push(child);
      return child;
    },
  };
});

const { browserOpenCommand, openBrowser } = await import("./open-browser.ts");

const URL = "http://localhost:8730";

beforeEach(() => {
  spawned.calls.length = 0;
  spawned.children.length = 0;
});

describe("browserOpenCommand", () => {
  it("uses the default URL handler of each platform", () => {
    expect(browserOpenCommand(URL, "darwin")).toEqual({
      command: "open",
      args: [URL],
    });
    expect(browserOpenCommand(URL, "linux")).toEqual({
      command: "xdg-open",
      args: [URL],
    });
    expect(browserOpenCommand(URL, "win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", URL],
    });
  });
});

describe("openBrowser", () => {
  it("spawns the opener and releases the event loop", () => {
    const warn = vi.fn();
    openBrowser(URL, warn, "darwin");

    expect(spawned.calls).toEqual([{ command: "open", args: [URL] }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns instead of throwing when the opener cannot be spawned", () => {
    const warn = vi.fn();
    openBrowser(URL, warn, "linux");
    spawned.children[0]?.emit("error", new Error("spawn xdg-open ENOENT"));

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not open http://localhost:8730"),
    );
  });

  it("warns when the opener exits non-zero and stays quiet on success", () => {
    const warn = vi.fn();
    openBrowser(URL, warn, "linux");
    spawned.children[0]?.emit("exit", 3);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("xdg-open exited with 3"),
    );

    warn.mockClear();
    openBrowser(URL, warn, "linux");
    spawned.children[1]?.emit("exit", 0);
    expect(warn).not.toHaveBeenCalled();
  });
});

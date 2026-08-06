import { describe, expect, it } from "vitest";
import { LH_WEB_HELP, parseLhWebArgs } from "./args.ts";

describe("parseLhWebArgs", () => {
  it("uses the default port with optional UI controls disabled", () => {
    expect(parseLhWebArgs([], {})).toEqual({
      port: 8730,
      debug: false,
      open: true,
      help: false,
    });
  });

  it("suppresses the browser with --no-open", () => {
    expect(parseLhWebArgs(["--no-open"], {}).open).toBe(false);
  });

  it("lets LOOPHUB_OPEN turn the browser off by default", () => {
    expect(parseLhWebArgs([], { LOOPHUB_OPEN: "0" }).open).toBe(false);
    expect(parseLhWebArgs([], { LOOPHUB_OPEN: "false" }).open).toBe(false);
    expect(parseLhWebArgs([], { LOOPHUB_OPEN: "1" }).open).toBe(true);
  });

  it("enables Web UI debugging controls without changing other options", () => {
    expect(parseLhWebArgs(["--debug", "--port", "9000"], {})).toMatchObject({
      port: 9000,
      debug: true,
    });
  });

  it("documents supported flags in help", () => {
    expect(parseLhWebArgs(["--help"], {}).help).toBe(true);
    expect(LH_WEB_HELP).toContain("--debug");
    expect(LH_WEB_HELP).toContain("--no-open");
  });

  it("rejects unknown and invalid options", () => {
    expect(() => parseLhWebArgs(["--unknown"], {})).toThrow("unknown option");
    expect(() => parseLhWebArgs(["--experimental"], {})).toThrow(
      "unknown option: --experimental",
    );
    expect(() => parseLhWebArgs(["--poll-ms", "250"], {})).toThrow(
      "unknown option: --poll-ms",
    );
    expect(() => parseLhWebArgs(["--port"], {})).toThrow("positive number");
  });
});

import { describe, expect, it } from "vitest";
import { LH_WEB_HELP, parseLhWebArgs } from "./args.ts";

describe("parseLhWebArgs", () => {
  it("uses the default port with optional UI controls disabled", () => {
    expect(parseLhWebArgs([], {})).toEqual({
      port: 8730,
      debug: false,
      help: false,
    });
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

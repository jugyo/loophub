import { describe, expect, it } from "vitest";
import { LH_WEB_HELP, parseLhWebArgs } from "./args.ts";

describe("parseLhWebArgs", () => {
  it("keeps experimental Web UI disabled by default", () => {
    expect(parseLhWebArgs([], {})).toEqual({
      port: 8730,
      experimental: false,
      debug: false,
      help: false,
    });
  });

  it("enables experimental Web UI without changing other options", () => {
    expect(
      parseLhWebArgs(["--experimental", "--port", "9000"], {}),
    ).toMatchObject({
      port: 9000,
      experimental: true,
    });
  });

  it("enables Web UI debugging controls without changing other options", () => {
    expect(parseLhWebArgs(["--debug", "--port", "9000"], {})).toMatchObject({
      port: 9000,
      debug: true,
    });
  });

  it("documents the experimental flag in help", () => {
    expect(parseLhWebArgs(["--help"], {}).help).toBe(true);
    expect(LH_WEB_HELP).toContain("--experimental");
    expect(LH_WEB_HELP).toContain("scheduled tasks");
    expect(LH_WEB_HELP).toContain("--debug");
  });

  it("rejects unknown and invalid options", () => {
    expect(() => parseLhWebArgs(["--unknown"], {})).toThrow("unknown option");
    expect(() => parseLhWebArgs(["--poll-ms", "250"], {})).toThrow(
      "unknown option: --poll-ms",
    );
    expect(() => parseLhWebArgs(["--port"], {})).toThrow("positive number");
  });
});

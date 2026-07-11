import { describe, expect, it } from "vitest";
import { LH_WEB_HELP, parseLhWebArgs } from "./args.ts";

describe("parseLhWebArgs", () => {
  it("keeps experimental Web UI disabled by default", () => {
    expect(parseLhWebArgs([], {})).toEqual({
      port: 8730,
      pollMs: 1000,
      experimental: false,
      help: false,
    });
  });

  it("enables experimental Web UI without changing other options", () => {
    expect(
      parseLhWebArgs(
        ["--experimental", "--port", "9000", "--poll-ms", "250"],
        {},
      ),
    ).toMatchObject({
      port: 9000,
      pollMs: 250,
      experimental: true,
    });
  });

  it("documents the experimental flag in help", () => {
    expect(parseLhWebArgs(["--help"], {}).help).toBe(true);
    expect(LH_WEB_HELP).toContain("--experimental");
    expect(LH_WEB_HELP).toContain("scheduled tasks");
  });

  it("rejects unknown and invalid options", () => {
    expect(() => parseLhWebArgs(["--unknown"], {})).toThrow("unknown option");
    expect(() => parseLhWebArgs(["--port"], {})).toThrow("positive number");
  });
});

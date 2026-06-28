import { describe, expect, it } from "vitest";
import { classifyTerminalLink } from "./terminal-link";

const ORIGIN = "http://localhost:8730";

describe("classifyTerminalLink", () => {
  it("treats a same-origin loophub URL as internal and keeps path + search + hash", () => {
    expect(
      classifyTerminalLink(`${ORIGIN}/r/jugyo/loophub/issues/300`, ORIGIN),
    ).toEqual({ kind: "internal", path: "/r/jugyo/loophub/issues/300" });
    expect(
      classifyTerminalLink(
        `${ORIGIN}/r/jugyo/loophub/pulls/12?tab=files#c1`,
        ORIGIN,
      ),
    ).toEqual({
      kind: "internal",
      path: "/r/jugyo/loophub/pulls/12?tab=files#c1",
    });
  });

  it("treats a different host/port/scheme as external", () => {
    expect(
      classifyTerminalLink("https://github.com/jugyo/loophub", ORIGIN),
    ).toEqual({
      kind: "external",
      uri: "https://github.com/jugyo/loophub",
    });
    // Different port → different origin → external.
    expect(
      classifyTerminalLink(
        "http://localhost:8731/r/jugyo/loophub/issues/1",
        ORIGIN,
      ),
    ).toEqual({
      kind: "external",
      uri: "http://localhost:8731/r/jugyo/loophub/issues/1",
    });
    // Same host/port but https vs http → different origin → external.
    expect(
      classifyTerminalLink(
        "https://localhost:8730/r/jugyo/loophub/issues/1",
        ORIGIN,
      ),
    ).toEqual({
      kind: "external",
      uri: "https://localhost:8730/r/jugyo/loophub/issues/1",
    });
  });

  it("does not hardcode a host/port — origin is taken from the argument", () => {
    const origin = "https://loophub.example.com";
    expect(classifyTerminalLink(`${origin}/r/o/r/issues/9`, origin)).toEqual({
      kind: "internal",
      path: "/r/o/r/issues/9",
    });
  });

  it("treats an unparseable URI as external", () => {
    expect(classifyTerminalLink("not a url", ORIGIN)).toEqual({
      kind: "external",
      uri: "not a url",
    });
  });
});

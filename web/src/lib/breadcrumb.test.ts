import { describe, expect, it } from "vitest";
import { crumbsForPath } from "./breadcrumb";

const labels = (path: string) => crumbsForPath(path).map((c) => c.label);

describe("crumbsForPath", () => {
  it("returns a single non-linked Home crumb for /", () => {
    const crumbs = crumbsForPath("/");
    expect(crumbs).toEqual([{ label: "Home", href: undefined }]);
  });

  it("renders the archived route", () => {
    expect(labels("/archived")).toEqual(["Home", "Archived"]);
  });

  it("renders a repo route with the full name", () => {
    expect(labels("/r/me/proj")).toEqual(["Home", "me/proj"]);
  });

  it("renders repo section routes", () => {
    expect(labels("/r/me/proj/issues")).toEqual(["Home", "me/proj", "Issues"]);
    expect(labels("/r/me/proj/pulls")).toEqual([
      "Home",
      "me/proj",
      "Pull requests",
    ]);
    expect(labels("/r/me/proj/merged")).toEqual(["Home", "me/proj", "Merged"]);
  });

  it("parses the issue/pull number into a #N crumb", () => {
    expect(labels("/r/me/proj/issues/12")).toEqual([
      "Home",
      "me/proj",
      "Issues",
      "#12",
    ]);
    expect(labels("/r/me/proj/pulls/3")).toEqual([
      "Home",
      "me/proj",
      "Pull requests",
      "#3",
    ]);
  });

  it("links every crumb except the last", () => {
    const crumbs = crumbsForPath("/r/me/proj/issues/12");
    expect(crumbs.slice(0, -1).every((c) => typeof c.href === "string")).toBe(
      true,
    );
    expect(crumbs[crumbs.length - 1].href).toBeUndefined();
  });
});

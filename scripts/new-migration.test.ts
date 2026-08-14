import { expect, test } from "vitest";
import { migrationTemplate } from "./new-migration.ts";

test("migration:new prints a UTC timestamp id and append-only entry", () => {
  expect(
    migrationTemplate(
      "add-foo-index",
      new Date("2026-08-14T05:45:17.999Z"),
      [],
    ),
  ).toBe(`migration ID: 20260814054517-add-foo-index

MIGRATIONS の末尾に次の entry を追加してください:

  {
    id: "20260814054517-add-foo-index",
    run: (db) => {
      // TODO: migration を実装する
    },
  },
`);
});

test("migration:new rejects an id already present in the migration list", () => {
  expect(() =>
    migrationTemplate("add-foo-index", new Date("2026-08-14T05:45:17.999Z"), [
      { id: "20260814054517-add-foo-index" },
    ]),
  ).toThrow("migration ID が既に存在します");
});

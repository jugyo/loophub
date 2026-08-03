import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createRotatingLogWriter } from "./rotating-log.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempLog(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "lh-rotating-log-"));
  dirs.push(dir);
  return { dir, file: join(dir, "service.log") };
}

test("writes each UTC hour to its own file", () => {
  const { dir, file } = tempLog();
  const writer = createRotatingLogWriter(file);

  writer.append("before", new Date("2026-08-03T10:59:59.000Z"));
  writer.append("after", new Date("2026-08-03T11:00:00.000Z"));

  expect(readFileSync(join(dir, "service.2026-08-03-10.log"), "utf8")).toBe(
    "before\n",
  );
  expect(readFileSync(join(dir, "service.2026-08-03-11.log"), "utf8")).toBe(
    "after\n",
  );
});

test("keeps every hourly archive intersecting the previous 24 hours", () => {
  const { dir, file } = tempLog();
  const expired = join(dir, "service.2026-08-02-10.log");
  const boundary = join(dir, "service.2026-08-02-11.log");
  writeFileSync(expired, "expired\n");
  writeFileSync(boundary, "retained\n");

  createRotatingLogWriter(file).append(
    "current",
    new Date("2026-08-03T11:30:00.000Z"),
  );

  expect(existsSync(expired)).toBe(false);
  expect(readFileSync(boundary, "utf8")).toBe("retained\n");
});

test("concurrent writers cannot move recent lines into an expired bucket", () => {
  const { dir, file } = tempLog();
  const first = createRotatingLogWriter(file);
  const second = createRotatingLogWriter(file);

  first.append("first old", new Date("2026-08-02T10:59:00.000Z"));
  second.append("second recent", new Date("2026-08-02T11:59:00.000Z"));
  first.append("first recent", new Date("2026-08-02T11:59:30.000Z"));
  second.append("next day", new Date("2026-08-03T11:00:00.000Z"));

  expect(existsSync(join(dir, "service.2026-08-02-10.log"))).toBe(false);
  expect(readFileSync(join(dir, "service.2026-08-02-11.log"), "utf8")).toBe(
    "second recent\nfirst recent\n",
  );
});

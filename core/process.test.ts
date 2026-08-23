import { expect, test } from "vitest";
import { readProcessStream } from "./process.ts";

test.each([
  ["stdout", ["sh", "-c", "printf 123456789"]],
  ["stderr", ["sh", "-c", "printf 123456789 >&2"]],
])("非同期プロセスの %s 出力を maxBuffer で制限する", async (_streamName, argv) => {
  const child = Bun.spawn(argv, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let killed = false;
  const stopAtLimit = () => {
    killed = true;
    child.kill("SIGTERM");
  };
  const [stdout, stderr] = await Promise.all([
    readProcessStream(child.stdout, 4, stopAtLimit),
    readProcessStream(child.stderr, 4, stopAtLimit),
    child.exited,
  ]);

  expect(stdout.text.length + stderr.text.length).toBeLessThanOrEqual(4);
  expect(stdout.exceededMaxBuffer || stderr.exceededMaxBuffer).toBe(true);
  expect(killed).toBe(true);
});

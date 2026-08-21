// Keeps Vitest's own process alive between test files.
//
// Vitest runs under Bun (the project runtime), and Bun does not treat a forked worker's IPC
// channel as work that keeps the event loop running. The moment the reporter is idle — which
// happens between files, and immediately after the first one when the pool is a single worker —
// Bun considers the loop empty and exits 0. The run then ends early with no summary and a success
// exit code, which would let a failing suite pass CI.
//
// A plain interval is enough to hold the loop open; Vitest calls the returned teardown when the
// run finishes, so it never delays the exit.
export default function keepVitestAlive(): () => void {
  const timer = setInterval(() => {}, 500);
  return () => clearInterval(timer);
}

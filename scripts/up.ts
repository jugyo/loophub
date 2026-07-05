import { type ChildProcess, spawn } from "node:child_process";

const passThroughArgs = process.argv.slice(2);
const children = new Map<ChildProcess, { name: string; running: boolean }>();
let shuttingDown = false;
let requestedSignal: NodeJS.Signals | null = null;
let exitCode = 0;

function npmRun(script: string): ChildProcess {
  const child = spawn("npm", ["run", script, "--", ...passThroughArgs], {
    stdio: "inherit",
  });
  children.set(child, { name: script, running: true });
  return child;
}

function stopAll(signal: NodeJS.Signals = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  requestedSignal = signal;
  for (const child of children.keys()) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill(signal);
  }
}

const web = npmRun("lh-web");
const worker = npmRun("lh-worker");

const signalExitCode = (signal: NodeJS.Signals): number =>
  signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;

function maybeExit() {
  for (const child of children.values()) {
    if (child.running) return;
  }
  process.exit(requestedSignal ? signalExitCode(requestedSignal) : exitCode);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopAll(signal);
  });
}

for (const child of [web, worker]) {
  child.on("exit", (code, signal) => {
    const state = children.get(child);
    if (state) {
      state.running = false;
      const status = signal ? `signal ${signal}` : `exit ${code ?? 0}`;
      console.error(`lh-up: ${state.name} exited (${status})`);
    }
    if (signal) exitCode = exitCode || signalExitCode(signal);
    else exitCode = exitCode || (code ?? 0);
    maybeExit();
  });
}

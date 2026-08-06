export interface LhWebArgs {
  port: number;
  debug: boolean;
  open: boolean;
  help: boolean;
}

export const LH_WEB_HELP = `Usage: lh-web [options]

Options:
  --port <n>       HTTP port (default: LOOPHUB_PORT or 8730)
  --debug          Show Web UI debugging controls
  --no-open        Do not open the UI in a browser after listening
                   (default: open, unless LOOPHUB_OPEN is 0 or false)
  -h, --help       Show this help
`;

function numberOption(name: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} requires a positive number`);
  }
  return parsed;
}

// Opening a browser is the default, but headless runs (CI, an evidence-capture lh-web, a remote
// shell) need a way to suppress it without editing the command line, so LOOPHUB_OPEN=0 / false
// flips the default off. --no-open suppresses it regardless of the environment.
function openDefault(value: string | undefined): boolean {
  return value !== "0" && value !== "false";
}

export function parseLhWebArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): LhWebArgs {
  const result: LhWebArgs = {
    port: numberOption("LOOPHUB_PORT", env.LOOPHUB_PORT ?? "8730"),
    debug: false,
    open: openDefault(env.LOOPHUB_OPEN),
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") result.port = numberOption(arg, argv[++i]);
    else if (arg === "--debug") result.debug = true;
    else if (arg === "--no-open") result.open = false;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }

  return result;
}

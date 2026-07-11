export interface LhWebArgs {
  port: number;
  pollMs: number;
  experimental: boolean;
  help: boolean;
}

export const LH_WEB_HELP = `Usage: lh-web [options]

Options:
  --port <n>       HTTP port (default: LOOPHUB_PORT or 8730)
  --poll-ms <ms>   Event polling interval (default: LOOPHUB_POLL_MS or 1000)
  --experimental   Show experimental Web UI, including scheduled tasks
  -h, --help       Show this help
`;

function numberOption(name: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} requires a positive number`);
  }
  return parsed;
}

export function parseLhWebArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): LhWebArgs {
  const result: LhWebArgs = {
    port: numberOption("LOOPHUB_PORT", env.LOOPHUB_PORT ?? "8730"),
    pollMs: numberOption("LOOPHUB_POLL_MS", env.LOOPHUB_POLL_MS ?? "1000"),
    experimental: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") result.port = numberOption(arg, argv[++i]);
    else if (arg === "--poll-ms") result.pollMs = numberOption(arg, argv[++i]);
    else if (arg === "--experimental") result.experimental = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }

  return result;
}

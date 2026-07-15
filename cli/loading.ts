const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface LoadingOptions {
  enabled?: boolean;
  intervalMs?: number;
  write?: (text: string) => unknown;
}

export async function withLoading<T>(
  message: string,
  operation: () => Promise<T>,
  options: LoadingOptions = {},
): Promise<T> {
  const enabled = options.enabled ?? process.stderr.isTTY === true;
  if (!enabled) return operation();

  const write = options.write ?? ((text: string) => process.stderr.write(text));
  let frame = 0;
  const render = () => {
    write(`\r${FRAMES[frame]} ${message}`);
    frame = (frame + 1) % FRAMES.length;
  };

  render();
  const timer = setInterval(render, options.intervalMs ?? 80);
  try {
    return await operation();
  } finally {
    clearInterval(timer);
    write("\r\u001b[2K");
  }
}

export function sanitizeWorkerLogMessage(message: string): string {
  return message.replace(/[\x00-\x1f\x7f]+/g, " ");
}

export const workerLog = {
  info(message: string) {
    console.log(sanitizeWorkerLogMessage(message));
  },
  error(message: string) {
    console.error(sanitizeWorkerLogMessage(message));
  },
};

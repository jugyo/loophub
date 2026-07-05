import { sweepPullUpdates } from "./shared.ts";

// ===== sync =====
export const sync = {
  async run() {
    const emitted = await sweepPullUpdates();
    return {
      updated: emitted.length,
      events: emitted.map((e: any) => ({ id: e.id, type: e.type })),
    };
  },
};

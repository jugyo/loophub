import { svc } from "../context.ts";

export async function run(): Promise<void> {
  const s = await svc();
  const r = await s.sync.run();
  console.log(`updated ${r.updated} PR(s)`);
}

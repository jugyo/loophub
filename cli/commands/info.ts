import { baseUrl, configDir, dbPath } from "../../core/config.ts";
import { flags } from "../args.ts";
import { out } from "../context.ts";

export async function run(): Promise<void> {
  // DB-free: report resolved environment so skills don't read ~/.loophub/config.json directly.
  const info = { baseUrl: baseUrl(), home: configDir(), dbPath: dbPath() };
  if (flags.json) out(info);
  else {
    console.log(`baseUrl\t${info.baseUrl}`);
    console.log(`home\t${info.home}`);
    console.log(`dbPath\t${info.dbPath}`);
  }
}

// Emit the language-neutral JSON-RPC contract (JSON Schema document) to docs/rpc-contract.json.
// Run: npm run contract
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// contract.ts -> service.ts -> db.ts opens a DB at import time; point it at a throwaway
// home so emitting the contract never touches real LoopHub data.
process.env.LOOPHUB_HOME = mkdtempSync(join(tmpdir(), "lh-contract-"));
process.env.LOOPHUB_DB = join(process.env.LOOPHUB_HOME, "contract.db");

const { contractDocument } = await import("../web/server/contract.ts");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "rpc-contract.json");
writeFileSync(out, `${JSON.stringify(contractDocument(), null, 2)}\n`);
console.error(`wrote ${out}`);

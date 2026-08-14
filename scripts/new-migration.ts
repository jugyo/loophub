import { fileURLToPath } from "node:url";
import {
  createMigrationId,
  MIGRATIONS,
  type Migration,
} from "../core/migrations.ts";

export function migrationTemplate(
  name: string,
  now: Date = new Date(),
  migrations: readonly Pick<Migration, "id">[] = MIGRATIONS,
): string {
  const id = createMigrationId(name, now);
  if (migrations.some((migration) => migration.id === id)) {
    throw new Error(`migration ID が既に存在します: ${id}`);
  }
  return `migration ID: ${id}

MIGRATIONS の末尾に次の entry を追加してください:

  {
    id: "${id}",
    run: (db) => {
      // TODO: migration を実装する
    },
  },
`;
}

function main(): void {
  const [name, ...extra] = process.argv.slice(2);
  if (!name || extra.length > 0) {
    throw new Error("使い方: npm run migration:new -- descriptive-name");
  }
  process.stdout.write(migrationTemplate(name));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

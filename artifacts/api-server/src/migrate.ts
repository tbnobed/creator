import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "@workspace/db";

const artifactDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(artifactDirectory, "../../../lib/db/drizzle");

async function run(): Promise<void> {
  try {
    await migrate(db, { migrationsFolder });
    console.info("Database migrations applied.");
  } finally {
    await pool.end();
  }
}

void run().catch((error: unknown) => {
  console.error("Database migration failed.", error);
  process.exitCode = 1;
});
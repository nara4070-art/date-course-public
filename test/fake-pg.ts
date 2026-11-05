// Stand-in for the `pg` package in tests: every Client talks to one shared
// in-memory Postgres (PGlite), so the real SQL in src/ runs unchanged.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

export const fake = {
  db: null as PGlite | null,
  failConnect: false, // simulate DB down
  failQuery: false, // simulate a query error after connecting
  connects: 0,
  ends: 0,
};

export async function startDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  fake.db = db;
  return db;
}

export async function resetDb(): Promise<void> {
  await fake.db!.exec("TRUNCATE courses, invites, sessions, users, spaces CASCADE");
  fake.failConnect = false;
  fake.failQuery = false;
  fake.connects = 0;
  fake.ends = 0;
}

export class Client {
  constructor(_opts?: unknown) {}

  async connect() {
    if (fake.failConnect) throw new Error("fake: connection refused");
    fake.connects++;
  }

  async query(text: string, params: unknown[] = []) {
    if (fake.failQuery) throw new Error("fake: query failed");
    const r = await fake.db!.query(text, params);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  }

  async end() {
    fake.ends++;
  }
}

export default { Client };

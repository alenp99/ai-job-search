import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config";

mkdirSync(DATA_DIR, { recursive: true });
export const db = new Database(path.join(DATA_DIR, "app.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key TEXT NOT NULL UNIQUE,
  portal TEXT NOT NULL,
  ext_id TEXT,
  url TEXT,
  title TEXT NOT NULL,
  company TEXT,
  location TEXT,
  posted_date TEXT,
  deadline TEXT,
  first_seen TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  quick_fit TEXT,
  quick_reason TEXT,
  posting_text TEXT,
  score INTEGER,
  verdict TEXT,
  evaluation TEXT,
  evaluated_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'drafting',
  cv_tex TEXT,
  cover_tex TEXT,
  cv_pdf BLOB,
  cover_pdf BLOB,
  report TEXT,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS company_research (
  name TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  notes TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  log TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
`);

// Anything left running when the process died will never finish.
db.run(
  "UPDATE tasks SET status = 'failed', log = log || ?, finished_at = ? WHERE status IN ('queued', 'running')",
  ["\n[server restarted before this task finished]", now()],
);
db.run("UPDATE applications SET status = 'failed' WHERE status = 'drafting'");

export function now(): string {
  return new Date().toISOString();
}

export function today(): string {
  return now().slice(0, 10);
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, JSON.stringify(value)],
  );
}

export interface JobRow {
  id: number;
  dedup_key: string;
  portal: string;
  ext_id: string | null;
  url: string | null;
  title: string;
  company: string | null;
  location: string | null;
  posted_date: string | null;
  deadline: string | null;
  first_seen: string;
  status: string;
  quick_fit: string | null;
  quick_reason: string | null;
  posting_text: string | null;
  score: number | null;
  verdict: string | null;
  evaluation: string | null;
  evaluated_at: string | null;
}

export function getJob(id: number): JobRow | null {
  return db.query("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null;
}

import { db, getSetting, now, today } from "./db";
import {
  draftApplication,
  evaluateJob,
  generateMasterCv,
  getAutomation,
  importCvPdf,
  interviewPrep,
  recompileApplication,
  runAutomation,
  runSearch,
  type Log,
} from "./pipeline";

type Payload = Record<string, unknown>;

const HANDLERS: Record<string, (p: Payload, log: Log) => Promise<unknown>> = {
  search: (_p, log) => runSearch(log),
  evaluate: (p, log) => evaluateJob(Number(p.jobId), log),
  draft: (p, log) => draftApplication(Number(p.jobId), log),
  master_cv: (_p, log) => generateMasterCv(log),
  import_cv: (p, log) => importCvPdf(String(p.pdf), log),
  interview: (p, log) => interviewPrep(Number(p.applicationId), log),
  recompile: (p, log) => recompileApplication(Number(p.applicationId), log),
  automation: (_p, log) => runAutomation(log),
};

export function enqueue(kind: string, label: string, payload: Payload = {}): number {
  if (!HANDLERS[kind]) throw new Error(`Unknown task ${kind}`);
  const res = db.run("INSERT INTO tasks (kind, label, payload, created_at) VALUES (?, ?, ?, ?)", [kind, label, JSON.stringify(payload), now()]);
  queueMicrotask(pump);
  return Number(res.lastInsertRowid);
}

// Claude calls are the bottleneck; two at a time keeps the UI responsive without
// tripping rate limits on a single API key.
const MAX_CONCURRENT = 2;
let running = 0;

function pump() {
  while (running < MAX_CONCURRENT) {
    const task = db.query("SELECT * FROM tasks WHERE status = 'queued' ORDER BY id LIMIT 1").get() as
      | { id: number; kind: string; payload: string }
      | null;
    if (!task) return;
    db.run("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?", [now(), task.id]);
    running++;
    void execute(task).finally(() => {
      running--;
      pump();
    });
  }
}

async function execute(task: { id: number; kind: string; payload: string }) {
  const log: Log = (msg) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}\n`;
    db.run("UPDATE tasks SET log = log || ? WHERE id = ?", [line, task.id]);
  };
  try {
    const payload = JSON.parse(task.payload) as Payload;
    if (task.kind === "import_cv") db.run("UPDATE tasks SET payload = '{}' WHERE id = ?", [task.id]);
    await HANDLERS[task.kind](payload, log);
    db.run("UPDATE tasks SET status = 'done', finished_at = ? WHERE id = ?", [now(), task.id]);
  } catch (e) {
    log(`Error: ${(e as Error).message}`);
    db.run("UPDATE tasks SET status = 'failed', finished_at = ? WHERE id = ?", [now(), task.id]);
  }
}

/** Fires the daily search once per UTC day at or after the configured hour. */
export function startScheduler() {
  const tick = () => {
    const a = getAutomation();
    if (!a.enabled) return;
    if (new Date().getUTCHours() < a.hourUtc) return;
    if (getSetting<string>("last_auto_run", "") === today()) return;
    const pending = db.query("SELECT 1 FROM tasks WHERE kind = 'automation' AND status IN ('queued','running')").get();
    if (pending) return;
    db.run("INSERT INTO settings (key, value) VALUES ('last_auto_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(today())]);
    enqueue("automation", "Daily automatic search");
  };
  setInterval(tick, 5 * 60_000);
  setTimeout(tick, 15_000);
}

import path from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { claudeConfigured } from "./claude";
import { APP_PASSWORD, MODEL, PORT, PUBLIC_DIR } from "./config";
import { db, getJob, getSetting, now, setSetting } from "./db";
import { endSession, isAuthed, passwordMatches, requireAuth, startSession } from "./auth";
import { latexAvailable } from "./latex";
import { addManualJob, DEFAULT_AUTOMATION, getAutomation, getSearchSettings, hostCheck, type AutomationSettings } from "./pipeline";
import { DEFAULT_SEARCH, PORTALS, type SearchSettings } from "./portals";
import { EMPTY_PROFILE, getMasterCv, getProfile, GUIDES, profileReady, type Profile } from "./prompts";
import { enqueue, startScheduler } from "./tasks";

const app = new Hono();

// Security headers for every response.
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header("X-Frame-Options", "DENY");
});

app.get("/api/health", (c) => c.json({ ok: true }));

// ------------------------------------------------------------ auth
const attempts = new Map<string, number[]>();
app.post("/api/login", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const recent = (attempts.get(ip) ?? []).filter((t) => Date.now() - t < 60_000);
  if (recent.length >= 8) return c.json({ error: "Too many attempts. Wait a minute." }, 429);
  attempts.set(ip, [...recent, Date.now()]);
  if (!APP_PASSWORD) return c.json({ error: "APP_PASSWORD is not set on the server." }, 503);
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: "" }));
  if (!password || !passwordMatches(password)) return c.json({ error: "Wrong password" }, 401);
  attempts.delete(ip);
  startSession(c);
  return c.json({ ok: true });
});
app.post("/api/logout", (c) => {
  endSession(c);
  return c.json({ ok: true });
});
app.get("/api/me", (c) => c.json({ authed: isAuthed(c), passwordSet: Boolean(APP_PASSWORD) }));

const api = new Hono();
api.use("*", requireAuth);

// ------------------------------------------------------------ status
let latexOk: boolean | null = null;
api.get("/status", async (c) => {
  latexOk ??= await latexAvailable();
  const counts = Object.fromEntries(
    (db.query("SELECT status, COUNT(*) c FROM jobs GROUP BY status").all() as { status: string; c: number }[]).map((r) => [r.status, r.c]),
  );
  const apps = Object.fromEntries(
    (db.query("SELECT status, COUNT(*) c FROM applications GROUP BY status").all() as { status: string; c: number }[]).map((r) => [r.status, r.c]),
  );
  return c.json({
    claude: claudeConfigured(),
    model: MODEL,
    latex: latexOk,
    profile: profileReady(),
    masterCv: Boolean(getMasterCv()),
    automation: getAutomation(),
    lastSearch: getSetting<string>("last_search", ""),
    lastAutoRun: getSetting<string>("last_auto_run", ""),
    jobs: counts,
    applications: apps,
    running: db.query("SELECT COUNT(*) c FROM tasks WHERE status IN ('queued','running')").get(),
  });
});

// ------------------------------------------------------------ profile
api.get("/profile", (c) =>
  c.json({ profile: getProfile(), masterCv: getMasterCv(), templates: { profile: GUIDES.profileTemplate, behavioral: GUIDES.behavioralTemplate } }),
);
api.put("/profile", async (c) => {
  const body = await c.req.json<Partial<Profile> & { masterCv?: string }>();
  const next: Profile = { ...EMPTY_PROFILE, ...getProfile() };
  for (const k of Object.keys(EMPTY_PROFILE) as (keyof Profile)[]) {
    if (typeof body[k] === "string") next[k] = (body[k] as string).slice(0, 100_000);
  }
  setSetting("profile", next);
  if (typeof body.masterCv === "string") setSetting("master_cv_tex", body.masterCv.slice(0, 200_000));
  return c.json({ ok: true });
});
api.post("/profile/import", async (c) => {
  const form = await c.req.formData();
  const file = form.get("cv");
  if (!(file instanceof File)) return c.json({ error: "Upload a PDF file" }, 400);
  if (file.size > 10_000_000) return c.json({ error: "PDF is larger than 10 MB" }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") return c.json({ error: "That file is not a PDF" }, 400);
  const id = enqueue("import_cv", "Import profile from CV", { pdf: Buffer.from(bytes).toString("base64") });
  return c.json({ taskId: id });
});
api.post("/profile/master-cv", (c) => c.json({ taskId: enqueue("master_cv", "Generate master CV") }));

// ------------------------------------------------------------ settings
api.get("/settings", (c) => c.json({ search: getSearchSettings(), automation: getAutomation(), portals: PORTALS }));
api.put("/settings", async (c) => {
  const body = await c.req.json<{ search?: Partial<SearchSettings>; automation?: Partial<AutomationSettings> }>();
  if (body.search) {
    const s = { ...DEFAULT_SEARCH, ...getSearchSettings(), ...body.search };
    s.queries = (s.queries ?? []).map(String).map((q) => q.trim()).filter(Boolean).slice(0, 20);
    s.jobage = Math.min(Math.max(Number(s.jobage) || 14, 1), 30);
    s.limitPerQuery = Math.min(Math.max(Number(s.limitPerQuery) || 15, 1), 50);
    setSetting("search", s);
  }
  if (body.automation) {
    const a = { ...DEFAULT_AUTOMATION, ...getAutomation(), ...body.automation };
    a.hourUtc = Math.min(Math.max(Number(a.hourUtc) || 0, 0), 23);
    a.autoEvaluate = Math.min(Math.max(Number(a.autoEvaluate) || 0, 0), 50);
    a.autoDraftThreshold = Math.min(Math.max(Number(a.autoDraftThreshold) || 0, 0), 100);
    a.maxAutoDrafts = Math.min(Math.max(Number(a.maxAutoDrafts) || 0, 0), 10);
    a.enabled = Boolean(a.enabled);
    setSetting("automation", a);
  }
  return c.json({ ok: true });
});

// ------------------------------------------------------------ jobs
const JOB_LIST_COLS = "id, portal, url, title, company, location, posted_date, deadline, first_seen, status, quick_fit, quick_reason, score, verdict, evaluated_at";
api.get("/jobs", (c) => {
  const status = c.req.query("status");
  const where = status && status !== "all" ? "WHERE status = ?" : "WHERE status != 'dismissed'";
  const rows = db
    .query(
      `SELECT ${JOB_LIST_COLS} FROM jobs ${where}
       ORDER BY COALESCE(score, -1) DESC, CASE quick_fit WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, id DESC LIMIT 500`,
    )
    .all(...(status && status !== "all" ? [status] : []));
  return c.json({ jobs: rows });
});
api.get("/jobs/:id", (c) => {
  const job = getJob(Number(c.req.param("id")));
  if (!job) return c.json({ error: "Not found" }, 404);
  const applications = db.query("SELECT id, status, created_at FROM applications WHERE job_id = ? ORDER BY id DESC").all(job.id);
  return c.json({ job: { ...job, evaluation: job.evaluation ? JSON.parse(job.evaluation) : null, source_host: hostCheck(job.url) }, applications });
});
api.post("/jobs", async (c) => {
  const body = await c.req.json<{ url?: string; text?: string }>();
  try {
    const id = await addManualJob(body);
    const taskId = enqueue("evaluate", "Evaluate added posting", { jobId: id });
    return c.json({ id, taskId });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
api.patch("/jobs/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ status?: string; posting_text?: string }>();
  if (body.status && ["new", "evaluated", "skipped", "dismissed", "drafted", "applied"].includes(body.status)) {
    db.run("UPDATE jobs SET status = ? WHERE id = ?", [body.status, id]);
  }
  if (typeof body.posting_text === "string") db.run("UPDATE jobs SET posting_text = ? WHERE id = ?", [body.posting_text, id]);
  return c.json({ ok: true });
});
api.post("/jobs/:id/evaluate", (c) => {
  const job = getJob(Number(c.req.param("id")));
  if (!job) return c.json({ error: "Not found" }, 404);
  return c.json({ taskId: enqueue("evaluate", `Evaluate: ${job.title}`, { jobId: job.id }) });
});
api.post("/jobs/:id/draft", (c) => {
  const job = getJob(Number(c.req.param("id")));
  if (!job) return c.json({ error: "Not found" }, 404);
  return c.json({ taskId: enqueue("draft", `Draft application: ${job.title}`, { jobId: job.id }) });
});
api.post("/search", (c) => c.json({ taskId: enqueue("search", "Search job portals") }));
api.post("/automation/run", (c) => c.json({ taskId: enqueue("automation", "Automatic search (manual run)") }));

// ------------------------------------------------------------ applications
api.get("/applications", (c) =>
  c.json({
    applications: db
      .query(
        `SELECT a.id, a.job_id, a.company, a.role, a.status, a.created_at, a.updated_at, a.notes, j.score, j.url, j.deadline
         FROM applications a LEFT JOIN jobs j ON j.id = a.job_id ORDER BY a.id DESC`,
      )
      .all(),
  }),
);
api.get("/applications/:id", (c) => {
  const a = db
    .query("SELECT id, job_id, company, role, status, created_at, updated_at, notes, cv_tex, cover_tex, report, cv_pdf IS NOT NULL has_pdf FROM applications WHERE id = ?")
    .get(Number(c.req.param("id"))) as Record<string, unknown> | null;
  if (!a) return c.json({ error: "Not found" }, 404);
  return c.json({ application: { ...a, report: a.report ? JSON.parse(String(a.report)) : null } });
});
api.patch("/applications/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ status?: string; notes?: string; cv_tex?: string; cover_tex?: string }>();
  const allowed = ["drafted", "applied", "interview", "offer", "rejected", "withdrawn", "no_response"];
  if (body.status && allowed.includes(body.status)) {
    db.run("UPDATE applications SET status = ?, updated_at = ? WHERE id = ?", [body.status, now(), id]);
    if (body.status === "applied") db.run("UPDATE jobs SET status = 'applied' WHERE id = (SELECT job_id FROM applications WHERE id = ?)", [id]);
  }
  if (typeof body.notes === "string") db.run("UPDATE applications SET notes = ?, updated_at = ? WHERE id = ?", [body.notes, now(), id]);
  if (typeof body.cv_tex === "string") db.run("UPDATE applications SET cv_tex = ?, updated_at = ? WHERE id = ?", [body.cv_tex, now(), id]);
  if (typeof body.cover_tex === "string") db.run("UPDATE applications SET cover_tex = ?, updated_at = ? WHERE id = ?", [body.cover_tex, now(), id]);
  return c.json({ ok: true });
});
api.delete("/applications/:id", (c) => {
  db.run("DELETE FROM applications WHERE id = ?", [Number(c.req.param("id"))]);
  return c.json({ ok: true });
});
api.post("/applications/:id/recompile", (c) =>
  c.json({ taskId: enqueue("recompile", "Recompile edited LaTeX", { applicationId: Number(c.req.param("id")) }) }),
);
api.post("/applications/:id/interview", (c) =>
  c.json({ taskId: enqueue("interview", "Interview prep", { applicationId: Number(c.req.param("id")) }) }),
);

function slug(s: string): string {
  return s.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "").slice(0, 40) || "file";
}
api.get("/applications/:id/:file{(?:cv|cover)\\.(?:pdf|tex)}", (c) => {
  const [doc, ext] = c.req.param("file").split(".");
  const col = `${doc}_${ext}`;
  const a = db.query(`SELECT company, role, ${col} AS body FROM applications WHERE id = ?`).get(Number(c.req.param("id"))) as
    | { company: string; role: string; body: Uint8Array | string | null }
    | null;
  if (!a?.body) return c.json({ error: "Not available" }, 404);
  const name = `${doc === "cv" ? "CV" : "Cover_letter"}_${slug(a.company)}_${slug(a.role)}.${ext}`;
  const download = c.req.query("download") === "1";
  return new Response(a.body as BodyInit, {
    headers: {
      "Content-Type": ext === "pdf" ? "application/pdf" : "text/plain; charset=utf-8",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
    },
  });
});

// ------------------------------------------------------------ tasks
api.get("/tasks", (c) =>
  c.json({ tasks: db.query("SELECT id, kind, label, status, created_at, started_at, finished_at FROM tasks ORDER BY id DESC LIMIT 50").all() }),
);
api.get("/tasks/:id", (c) => c.json({ task: db.query("SELECT id, kind, label, status, log, created_at, started_at, finished_at FROM tasks WHERE id = ?").get(Number(c.req.param("id"))) }));

app.route("/api", api);
const publicRoot = path.relative(process.cwd(), PUBLIC_DIR) || ".";
app.use("/*", serveStatic({ root: publicRoot }));
app.get("*", serveStatic({ path: `${publicRoot}/index.html` }));

startScheduler();
console.log(`AI Job Search web app on :${PORT} (model ${MODEL}, password ${APP_PASSWORD ? "set" : "NOT SET"})`);

export default { port: PORT, fetch: app.fetch, idleTimeout: 120 };

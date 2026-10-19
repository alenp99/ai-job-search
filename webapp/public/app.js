// AI Job Search web app - single-file client. All third-party text (portal results,
// postings, model output) is escaped before it reaches innerHTML.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const view = $("#view");

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("Not signed in");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? esc(iso) : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
function fmtTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function fitChip(job) {
  if (job.score != null) {
    const cls = job.score >= 60 ? "good" : job.score >= 45 ? "warn" : "bad";
    return `<span class="chip ${cls}" title="${esc(job.verdict)}">${esc(job.score)}</span>`;
  }
  return job.quick_fit ? `<span class="chip ${esc(job.quick_fit)}" title="${esc(job.quick_reason)}">${esc(job.quick_fit)}</span>` : `<span class="chip">-</span>`;
}
const STATUS_LABEL = {
  new: "New", evaluated: "Evaluated", skipped: "Gate failed", dismissed: "Dismissed", drafted: "Drafted", applied: "Applied",
  drafting: "Drafting…", failed: "Failed", interview: "Interview", offer: "Offer", rejected: "Rejected", withdrawn: "Withdrawn", no_response: "No response",
};
const statusChip = (s) => {
  const cls = { applied: "good", offer: "good", interview: "good", drafted: "warn", drafting: "warn", failed: "bad", rejected: "bad", skipped: "bad" }[s] ?? "";
  return `<span class="chip ${cls}">${esc(STATUS_LABEL[s] ?? s)}</span>`;
};

const taskChip = (s) => `<span class="chip ${s === "done" ? "good" : s === "failed" ? "bad" : "warn"}">${esc(s)}</span>`;

// Minimal Markdown for model-written prep packs: headings, bullets, bold. Input is escaped first.
function md(text) {
  return esc(text)
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h2>$1</h2>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^\s*[-*] (.*)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul class="tight">${m}</ul>`)
    .replace(/\n{2,}/g, "<br><br>");
}

// ------------------------------------------------------------ tasks
const watched = new Map();
async function startTask(promise, doneMsg) {
  try {
    const { taskId } = await promise;
    toast("Started - follow progress in Activity");
    watched.set(taskId, doneMsg);
    pollTasks();
    return taskId;
  } catch (e) {
    toast(e.message, 6000);
  }
}
let pollTimer;
async function pollTasks() {
  clearTimeout(pollTimer);
  try {
    const { tasks } = await api("/tasks");
    const active = tasks.filter((t) => t.status === "queued" || t.status === "running").length;
    const badge = $("#running-badge");
    badge.textContent = active;
    badge.classList.toggle("hidden", !active);
    for (const t of tasks) {
      if (watched.has(t.id) && (t.status === "done" || t.status === "failed")) {
        const msg = watched.get(t.id);
        watched.delete(t.id);
        toast(t.status === "done" ? msg || `${t.label}: done` : `${t.label}: failed - see Activity`, 6000);
        route();
      }
    }
    if (active || watched.size) pollTimer = setTimeout(pollTasks, 3000);
  } catch {}
}

// ------------------------------------------------------------ views
async function dashboard() {
  const s = await api("/status");
  const { jobs } = await api("/jobs");
  const { tasks } = await api("/tasks");
  const banners = [];
  if (!s.claude) banners.push(`<div class="banner warn"><strong>Claude API key missing.</strong> Set <code>ANTHROPIC_API_KEY</code> in Railway → Variables, then redeploy.</div>`);
  if (!s.latex) banners.push(`<div class="banner warn"><strong>LaTeX is not installed on this server</strong>, so PDFs can't be compiled.</div>`);
  if (!s.profile.ok) banners.push(`<div class="banner info"><strong>Start here:</strong> fill in your <a href="#/profile">profile</a> (upload your current CV to do it in one step), then add search queries in <a href="#/settings">Search &amp; automation</a>.</div>`);
  const top = jobs.filter((j) => ["new", "evaluated"].includes(j.status)).slice(0, 8);
  const n = (k) => s.jobs[k] ?? 0;
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p class="muted">Last search: ${s.lastSearch ? fmtTime(s.lastSearch) : "never"} · Daily automation: ${s.automation.enabled ? `on, ${s.automation.hourUtc}:00 UTC` : "off"}</p></div>
      <div class="row"><button class="btn primary" id="run-search">Search jobs now</button></div>
    </div>
    ${banners.join("")}
    <div class="grid cols-4">
      <div class="card stat"><div class="num">${n("new")}</div><div class="muted">New matches</div></div>
      <div class="card stat"><div class="num">${n("evaluated")}</div><div class="muted">Evaluated</div></div>
      <div class="card stat"><div class="num">${(s.applications.drafted ?? 0)}</div><div class="muted">Drafts ready</div></div>
      <div class="card stat"><div class="num">${(s.applications.applied ?? 0) + (s.applications.interview ?? 0) + (s.applications.offer ?? 0)}</div><div class="muted">Sent</div></div>
    </div>
    <div class="grid cols-2">
      <div class="card">
        <h2>Add a job posting</h2>
        <p class="muted small">Paste a link (or the full text). It gets fetched and evaluated against your profile.</p>
        <form id="add-job">
          <input type="url" name="url" placeholder="https://… job posting URL">
          <details style="margin-top:8px"><summary class="small muted">or paste the posting text</summary>
            <textarea name="text" placeholder="Full posting text"></textarea></details>
          <div class="row" style="margin-top:10px"><button class="btn primary" type="submit">Add &amp; evaluate</button></div>
        </form>
      </div>
      <div class="card">
        <h2>Recent activity</h2>
        ${tasks.length ? `<table><tbody>${tasks.slice(0, 6).map((t) => `<tr class="clickable" data-href="#/activity/${t.id}"><td>${esc(t.label)}</td><td>${taskChip(t.status)}</td><td class="muted small">${fmtTime(t.created_at)}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">Nothing yet.</p>`}
      </div>
    </div>
    <div class="card">
      <div class="page-head" style="margin:0 0 6px"><h2>Top matches</h2><a href="#/jobs">All jobs →</a></div>
      ${top.length ? jobTable(top) : `<p class="muted">No open matches yet. Run a search or add a posting.</p>`}
    </div>`;
  $("#run-search").onclick = () => startTask(api("/search", { method: "POST" }), "Search finished");
  $("#add-job").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Fetching…";
    try {
      const { id, taskId } = await api("/jobs", { method: "POST", body: { url: f.get("url"), text: f.get("text") } });
      watched.set(taskId, "Evaluation ready");
      pollTasks();
      location.hash = `#/jobs/${id}`;
    } catch (err) {
      toast(err.message, 6000);
      btn.disabled = false;
      btn.textContent = "Add & evaluate";
    }
  };
}

function jobTable(jobs) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Fit</th><th>Role</th><th class="hide-sm">Location</th><th class="hide-sm">Posted</th><th>Deadline</th><th>Status</th></tr></thead>
    <tbody>${jobs
      .map(
        (j) => `<tr class="clickable" data-href="#/jobs/${j.id}">
          <td>${fitChip(j)}</td>
          <td><strong>${esc(j.title)}</strong><div class="muted small">${esc(j.company ?? "")}${j.portal ? ` · ${esc(j.portal.replace("-search", ""))}` : ""}</div></td>
          <td class="hide-sm">${esc(j.location ?? "")}</td>
          <td class="hide-sm small">${fmtDate(j.posted_date)}</td>
          <td class="small">${fmtDate(j.deadline)}</td>
          <td>${statusChip(j.status)}</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
}

let jobFilter = "active";
async function jobsView() {
  const q = jobFilter === "active" ? "" : `?status=${jobFilter}`;
  const { jobs } = await api(`/jobs${q}`);
  const tabs = [["active", "Active"], ["new", "New"], ["evaluated", "Evaluated"], ["drafted", "Drafted"], ["applied", "Applied"], ["skipped", "Gate failed"], ["dismissed", "Dismissed"]];
  view.innerHTML = `
    <div class="page-head"><div><h1>Jobs</h1><p class="muted">Sorted by evaluation score, then quick fit.</p></div>
      <button class="btn primary" id="run-search">Search jobs now</button></div>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-filter="${k}" class="${k === jobFilter ? "active" : ""}">${l}</button>`).join("")}</div>
    <div class="card">${jobs.length ? jobTable(jobs) : `<p class="muted">No jobs here.</p>`}</div>`;
  view.querySelectorAll("[data-filter]").forEach((b) => (b.onclick = () => ((jobFilter = b.dataset.filter), jobsView())));
  $("#run-search").onclick = () => startTask(api("/search", { method: "POST" }), "Search finished");
}

function linkedinSearch(keywords) {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}&origin=GLOBAL_SEARCH_HEADER`;
}

async function jobDetail(id) {
  const { job, applications } = await api(`/jobs/${id}`);
  const ev = job.evaluation;
  const safeUrl = job.url && /^https?:\/\//.test(job.url) ? job.url : null;
  const dim = (label, d) => `<tr><td>${label}</td><td><span class="score">${esc(d.score)}</span>/100</td><td>${esc(d.note)}</td></tr>`;
  const gate = (label, g) => `<tr><td>${label}</td><td><span class="chip ${esc(g.verdict)}">${esc(g.verdict)}</span></td><td>${esc(g.note)}</td></tr>`;
  view.innerHTML = `
    <p><a href="#/jobs">← Jobs</a></p>
    <div class="page-head">
      <div><h1>${esc(ev?.role || job.title)}</h1>
        <p class="muted">${esc(ev?.company || job.company || "")}${job.location ? ` · ${esc(job.location)}` : ""}${job.deadline ? ` · Deadline ${fmtDate(job.deadline)}` : ""} · ${statusChip(job.status)}</p></div>
      <div class="row">
        ${safeUrl ? `<a class="btn" href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer">Open posting ↗</a>` : ""}
        <button class="btn" id="evaluate">${ev ? "Re-evaluate" : "Evaluate fit"}</button>
        <button class="btn primary" id="draft" ${ev && ev.verdict === "Gate failed" ? "disabled" : ""}>Draft CV + cover letter</button>
        ${job.status === "dismissed" ? `<button class="btn" id="restore">Restore</button>` : `<button class="btn danger" id="dismiss">Dismiss</button>`}
      </div>
    </div>
    ${applications.length ? `<div class="banner info">Applications for this job: ${applications.map((a) => `<a href="#/applications/${a.id}">#${a.id}</a> ${statusChip(a.status)}`).join(" ")}</div>` : ""}
    ${
      ev
        ? `<div class="card">
        <div class="page-head" style="margin:0"><h2>Fit evaluation</h2><div><span class="chip ${ev.overall >= 60 ? "good" : ev.overall >= 45 ? "warn" : "bad"}" style="font-size:15px">${esc(ev.verdict)} · ${esc(ev.overall)}/100</span></div></div>
        <p class="small ${ev.source_host?.startsWith("⚠") ? "error" : "muted"}">Source: ${esc(ev.source_host)}</p>
        <div class="table-wrap"><table class="dims"><tbody>
          ${gate("Eligibility", ev.eligibility_gate)}${gate("Language", ev.language_gate)}
          ${dim("Technical skills (30%)", ev.technical)}${dim("Experience (25%)", ev.experience)}${dim("Behavioral fit (15%)", ev.behavioral)}${dim("Career alignment (30%)", ev.career)}
          ${gate("Location", ev.location_check)}
        </tbody></table></div>
        <div class="grid cols-2" style="margin-top:12px">
          <div><h3>Strengths</h3><ul class="tight">${ev.strengths.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
          <div><h3>Gaps</h3><ul class="tight">${ev.gaps.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
        </div>
        <h3 style="margin-top:12px">Recommendation</h3><p>${esc(ev.recommendation)}</p>
        ${ev.call_employer_questions?.length ? `<h3>Worth asking the employer</h3><ul class="tight">${ev.call_employer_questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}
        <h3>Keywords</h3><div class="row">${ev.keywords.map((k) => `<span class="chip ${k.priority === "required" ? "" : "muted"}">${esc(k.term)}</span>`).join("")}</div>
        <h3 style="margin-top:12px">Find a referral</h3>
        <div class="row small"><a href="${esc(linkedinSearch(`${ev.company} recruiter`))}" target="_blank" rel="noopener">Recruiters at ${esc(ev.company)} ↗</a>
        <a href="${esc(linkedinSearch(`${ev.company} ${ev.role}`))}" target="_blank" rel="noopener">People in similar roles ↗</a></div>
      </div>`
        : `<div class="card"><p class="muted">Not evaluated yet.${job.quick_fit ? ` Quick signal: ${fitChip(job)} ${esc(job.quick_reason ?? "")}` : ""}</p></div>`
    }
    <div class="card">
      <h2>Posting text</h2>
      <p class="muted small">Fetched from the portal when you evaluate the job. If it's wrong or empty (login wall), paste the real posting here and save before evaluating.</p>
      <textarea id="posting" class="tall">${esc(job.posting_text ?? "")}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn" id="save-posting">Save text</button></div>
    </div>`;
  $("#evaluate").onclick = () => startTask(api(`/jobs/${id}/evaluate`, { method: "POST" }), "Evaluation ready");
  $("#draft").onclick = () => {
    if (ev && ev.experience.score < 50 && !confirm("Experience match is below 50: drafting would need heavy reframing. Draft anyway?")) return;
    startTask(api(`/jobs/${id}/draft`, { method: "POST" }), "Application drafted - see Applications");
  };
  const setStatus = (status) => api(`/jobs/${id}`, { method: "PATCH", body: { status } }).then(() => jobDetail(id));
  $("#dismiss") && ($("#dismiss").onclick = () => setStatus("dismissed"));
  $("#restore") && ($("#restore").onclick = () => setStatus(ev ? "evaluated" : "new"));
  $("#save-posting").onclick = async () => {
    await api(`/jobs/${id}`, { method: "PATCH", body: { posting_text: $("#posting").value } });
    toast("Saved");
  };
}

async function applicationsView() {
  const { applications } = await api("/applications");
  view.innerHTML = `
    <div class="page-head"><div><h1>Applications</h1><p class="muted">Your tracker. Mark an application as applied once you've sent it.</p></div></div>
    <div class="card">${
      applications.length
        ? `<div class="table-wrap"><table><thead><tr><th>Company / role</th><th>Status</th><th class="hide-sm">Fit</th><th class="hide-sm">Deadline</th><th>Updated</th></tr></thead><tbody>
      ${applications
        .map(
          (a) => `<tr class="clickable" data-href="#/applications/${a.id}"><td><strong>${esc(a.company)}</strong><div class="muted small">${esc(a.role)}</div></td>
        <td>${statusChip(a.status)}</td><td class="hide-sm">${a.score != null ? esc(a.score) : ""}</td><td class="hide-sm small">${fmtDate(a.deadline)}</td><td class="small muted">${fmtTime(a.updated_at)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
        : `<p class="muted">No applications yet. Open a job and choose “Draft CV + cover letter”.</p>`
    }</div>`;
}

let docTab = "cv";
async function applicationDetail(id) {
  const { application: a } = await api(`/applications/${id}`);
  const r = a.report;
  const statuses = ["drafted", "applied", "interview", "offer", "rejected", "withdrawn", "no_response"];
  const covered = r?.ats?.filter((k) => k.status === "covered").length ?? 0;
  view.innerHTML = `
    <p><a href="#/applications">← Applications</a>${a.job_id ? ` · <a href="#/jobs/${a.job_id}">Job</a>` : ""}</p>
    <div class="page-head">
      <div><h1>${esc(a.company)}</h1><p class="muted">${esc(a.role)} · created ${fmtTime(a.created_at)}</p></div>
      <div class="row">
        ${a.status === "drafting" || a.status === "failed" ? statusChip(a.status) : `<select id="status">${statuses.map((s) => `<option value="${s}" ${s === a.status ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("")}</select>`}
        <button class="btn danger small" id="delete">Delete</button>
      </div>
    </div>
    ${a.status === "failed" ? `<div class="banner warn"><strong>Drafting failed:</strong> ${esc(a.notes)}</div>` : ""}
    ${a.status === "drafting" ? `<div class="banner info">Drafting in progress (draft → reviewer → revise → compile). This takes a few minutes; see <a href="#/activity">Activity</a>.</div>` : ""}
    ${
      a.has_pdf
        ? `<div class="card">
      <div class="page-head" style="margin:0 0 10px">
        <div class="tabs" style="margin:0"><button data-doc="cv" class="${docTab === "cv" ? "active" : ""}">CV${r?.cv_pages ? ` (${r.cv_pages}p)` : ""}</button><button data-doc="cover" class="${docTab === "cover" ? "active" : ""}">Cover letter${r?.cover_pages ? ` (${r.cover_pages}p)` : ""}</button></div>
        <div class="row">
          <a class="btn small" href="/api/applications/${id}/${docTab}.pdf?download=1">Download PDF</a>
          <a class="btn small" href="/api/applications/${id}/${docTab}.tex?download=1">Download .tex</a>
        </div>
      </div>
      <iframe class="pdf-frame" src="/api/applications/${id}/${docTab}.pdf#view=FitH" title="PDF preview"></iframe>
    </div>`
        : ""
    }
    ${
      r
        ? `<div class="grid cols-2">
      <div class="card"><h2>Key tailoring decisions</h2><ul class="tight">${r.decisions.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
        ${r.stretch_flags?.length ? `<h3 style="margin-top:12px">Check these stretches</h3><ul class="tight">${r.stretch_flags.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
        ${r.review.grounding_warnings?.length ? `<h3 style="margin-top:12px">Profile consistency warnings</h3><ul class="tight">${r.review.grounding_warnings.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
      </div>
      <div class="card"><h2>ATS keyword coverage</h2><p class="muted small">${covered}/${r.ats.length} keywords found in the CV's text layer. Missing items are either genuine gaps or worth adding by hand if you have them; never stuff keywords.</p>
        ${r.ats_issues?.length ? `<ul class="tight error">${r.ats_issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}
        <div class="row">${r.ats.map((k) => `<span class="chip ${k.status === "covered" ? "good" : k.priority === "required" ? "bad" : "warn"}" title="${esc(k.priority)}">${esc(k.keyword)}</span>`).join("")}</div>
      </div>
    </div>
    <div class="card"><details><summary><strong>Reviewer feedback</strong> <span class="muted small">(${r.review.edits_applied}/${r.review.edits_proposed} direct edits applied)</span></summary>
      <dl class="kv" style="margin-top:10px"><dt>Missed keywords</dt><dd>${esc(r.review.missed_keywords)}</dd><dt>Company angles</dt><dd>${esc(r.review.company_angles)}</dd><dt>Reframing</dt><dd>${esc(r.review.reframing)}</dd><dt>Tone</dt><dd>${esc(r.review.tone)}</dd></dl>
      <h3 style="margin-top:12px">Company research</h3><pre>${esc(r.company_research)}</pre></details></div>
    <div class="card"><div class="page-head" style="margin:0"><h2>Interview prep</h2><button class="btn small" id="interview">${r.interview_prep ? "Regenerate" : "Generate prep pack"}</button></div>
      ${r.interview_prep ? `<div>${md(r.interview_prep)}</div>` : `<p class="muted">Generate a prep pack once you're invited to interview.</p>`}</div>`
        : ""
    }
    ${
      a.cv_tex
        ? `<div class="card"><details><summary><strong>Edit LaTeX</strong> <span class="muted small">(advanced)</span></summary>
      <label>CV (lualatex)</label><textarea id="cv-tex" class="tall mono">${esc(a.cv_tex)}</textarea>
      <label>Cover letter (xelatex)</label><textarea id="cover-tex" class="tall mono">${esc(a.cover_tex)}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn primary" id="save-tex">Save &amp; recompile</button></div></details></div>`
        : ""
    }
    <div class="card"><h2>Notes</h2><textarea id="notes" placeholder="Contact, dates, follow-ups…">${esc(a.status === "failed" ? "" : a.notes ?? "")}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn" id="save-notes">Save notes</button></div></div>`;

  view.querySelectorAll("[data-doc]").forEach((b) => (b.onclick = () => ((docTab = b.dataset.doc), applicationDetail(id))));
  $("#status") && ($("#status").onchange = async (e) => {
    await api(`/applications/${id}`, { method: "PATCH", body: { status: e.target.value } });
    toast("Status updated");
  });
  $("#delete").onclick = async () => {
    if (!confirm("Delete this application and its documents?")) return;
    await api(`/applications/${id}`, { method: "DELETE" });
    location.hash = "#/applications";
  };
  $("#interview") && ($("#interview").onclick = () => startTask(api(`/applications/${id}/interview`, { method: "POST" }), "Interview prep ready"));
  $("#save-tex") && ($("#save-tex").onclick = async () => {
    await api(`/applications/${id}`, { method: "PATCH", body: { cv_tex: $("#cv-tex").value, cover_tex: $("#cover-tex").value } });
    startTask(api(`/applications/${id}/recompile`, { method: "POST" }), "PDFs recompiled");
  });
  $("#save-notes").onclick = async () => {
    await api(`/applications/${id}`, { method: "PATCH", body: { notes: $("#notes").value } });
    toast("Notes saved");
  };
}

async function profileView() {
  const { profile: p, masterCv, templates } = await api("/profile");
  const field = (k, label, type = "text") => `<div><label for="p-${k}">${label}</label><input type="${type}" id="p-${k}" name="${k}" value="${esc(p[k])}"></div>`;
  view.innerHTML = `
    <div class="page-head"><div><h1>Profile</h1><p class="muted">The single source of truth for every CV and cover letter. Nothing is ever claimed that isn't here.</p></div></div>
    <div class="card">
      <h2>Quick start: import your current CV</h2>
      <p class="muted small">Upload a PDF and Claude fills in the fields below. Review the result: it only copies what your CV says.</p>
      <form id="import" class="row"><input type="file" name="cv" accept="application/pdf" required><button class="btn" type="submit">Import</button></form>
    </div>
    <form id="profile-form">
      <div class="card">
        <h2>Contact</h2>
        <div class="grid cols-2">${field("name", "Full name")}${field("email", "Email", "email")}${field("phone", "Phone")}${field("city", "City")}${field("country", "Country")}${field("linkedin", "LinkedIn URL", "url")}${field("github", "GitHub / portfolio URL", "url")}
          <div><label for="p-cvLanguage">CV language <span class="hint">(cover letters follow each posting's language)</span></label><input type="text" id="p-cvLanguage" name="cvLanguage" value="${esc(p.cvLanguage)}"></div></div>
      </div>
      <div class="card">
        <h2>Candidate profile</h2>
        <p class="muted small">Experience (titles, employers, dates, achievements with numbers), education, skills, languages with levels, projects, publications, awards, and how you work best. More detail = better tailoring.</p>
        <textarea name="profileMd" class="tall" placeholder="${esc(templates.profile + "\n\n" + templates.behavioral)}">${esc(p.profileMd)}</textarea>
      </div>
      <div class="card">
        <h2>Preferences &amp; deal-breakers</h2>
        <p class="muted small">Used to score fit: target roles and sectors, career goals, tasks that energize or drain you, commute range / remote preference, work permit or citizenship status, salary expectations, deal-breakers.</p>
        <textarea name="preferencesMd" placeholder="e.g. Target: ML engineer / data scientist roles in energy or climate tech.&#10;Location: Copenhagen area or remote; no relocation.&#10;Work permit: EU citizen.&#10;Deal-breakers: pure maintenance roles, >30% travel.">${esc(p.preferencesMd)}</textarea>
      </div>
      <div class="card">
        <div class="page-head" style="margin:0"><div><h2>Master CV (LaTeX)</h2><p class="muted small">Your complete reference CV in the moderncv template. Tailored CVs are cut down from this. Generate it from your profile, or paste your own.</p></div>
          <button class="btn" type="button" id="gen-master">${masterCv ? "Regenerate from profile" : "Generate from profile"}</button></div>
        <textarea name="masterCv" class="tall mono" placeholder="Generated automatically before your first application if left empty.">${esc(masterCv)}</textarea>
      </div>
      <div class="row"><button class="btn primary" type="submit">Save profile</button></div>
    </form>`;
  $("#import").onsubmit = async (e) => {
    e.preventDefault();
    const taskId = await startTask(api("/profile/import", { method: "POST", body: new FormData(e.target) }), "Profile imported - review it");
    if (taskId) e.target.reset();
  };
  $("#profile-form").onsubmit = async (e) => {
    e.preventDefault();
    await api("/profile", { method: "PUT", body: Object.fromEntries(new FormData(e.target)) });
    toast("Profile saved");
  };
  $("#gen-master").onclick = async () => {
    await api("/profile", { method: "PUT", body: Object.fromEntries(new FormData($("#profile-form"))) });
    startTask(api("/profile/master-cv", { method: "POST" }), "Master CV generated");
  };
}

async function settingsView() {
  const { search: s, automation: a, portals } = await api("/settings");
  view.innerHTML = `
    <div class="page-head"><div><h1>Search &amp; automation</h1><p class="muted">What to look for, where, and what to do automatically each day.</p></div></div>
    <form id="settings">
      <div class="card">
        <h2>Search</h2>
        <label>Search queries <span class="hint">(one per line: job titles or skills, e.g. "data scientist", "python machine learning")</span></label>
        <textarea name="queries">${esc(s.queries.join("\n"))}</textarea>
        <div class="grid cols-2">
          <div><label>Posted within (days)</label><input type="number" name="jobage" min="1" max="30" value="${esc(s.jobage)}"></div>
          <div><label>Max results per query per portal</label><input type="number" name="limitPerQuery" min="1" max="50" value="${esc(s.limitPerQuery)}"></div>
        </div>
      </div>
      <div class="card">
        <h2>Job portals</h2>
        ${Object.entries(portals)
          .map(([k, p]) => `<label class="check"><input type="checkbox" name="portal:${k}" ${s.portals[k] ? "checked" : ""}> ${esc(p.label)} <span class="muted small">${esc(p.region)}</span></label>`)
          .join("")}
        <div class="grid cols-2">
          <div><label>LinkedIn location <span class="hint">(required for LinkedIn, e.g. "Berlin, Germany" or "Remote")</span></label><input type="text" name="linkedinLocation" value="${esc(s.linkedinLocation)}"></div>
          <div><label>LinkedIn workplace</label><select name="linkedinRemote">${["", "remote", "hybrid", "onsite"].map((v) => `<option value="${v}" ${v === s.linkedinRemote ? "selected" : ""}>${v || "Any"}</option>`).join("")}</select></div>
          <div><label>freehire.me countries <span class="hint">(ISO codes, e.g. "DE,GB"; empty = all)</span></label><input type="text" name="freehireCountries" value="${esc(s.freehireCountries)}"></div>
        </div>
      </div>
      <div class="card">
        <h2>Daily automation</h2>
        <label class="check"><input type="checkbox" name="enabled" ${a.enabled ? "checked" : ""}> Run a search automatically every day</label>
        <div class="grid cols-2">
          <div><label>Run at (hour, UTC)</label><input type="number" name="hourUtc" min="0" max="23" value="${esc(a.hourUtc)}"></div>
          <div><label>Auto-evaluate up to N high/medium matches</label><input type="number" name="autoEvaluate" min="0" max="50" value="${esc(a.autoEvaluate)}"></div>
          <div><label>Auto-draft applications scoring at least <span class="hint">(0 = never)</span></label><input type="number" name="autoDraftThreshold" min="0" max="100" value="${esc(a.autoDraftThreshold)}"></div>
          <div><label>Max auto-drafts per day</label><input type="number" name="maxAutoDrafts" min="0" max="10" value="${esc(a.maxAutoDrafts)}"></div>
        </div>
        <p class="muted small">Drafts are never sent anywhere. You review and submit each application yourself.</p>
      </div>
      <div class="row"><button class="btn primary" type="submit">Save settings</button><button class="btn" type="button" id="run-auto">Run automation now</button></div>
    </form>`;
  const collect = () => {
    const f = new FormData($("#settings"));
    const portalsOn = Object.fromEntries(Object.keys(portals).map((k) => [k, f.get(`portal:${k}`) === "on"]));
    return {
      search: {
        queries: String(f.get("queries")).split("\n"),
        jobage: Number(f.get("jobage")),
        limitPerQuery: Number(f.get("limitPerQuery")),
        portals: portalsOn,
        linkedinLocation: f.get("linkedinLocation"),
        linkedinRemote: f.get("linkedinRemote"),
        freehireCountries: f.get("freehireCountries"),
      },
      automation: {
        enabled: f.get("enabled") === "on",
        hourUtc: Number(f.get("hourUtc")),
        autoEvaluate: Number(f.get("autoEvaluate")),
        autoDraftThreshold: Number(f.get("autoDraftThreshold")),
        maxAutoDrafts: Number(f.get("maxAutoDrafts")),
      },
    };
  };
  $("#settings").onsubmit = async (e) => {
    e.preventDefault();
    await api("/settings", { method: "PUT", body: collect() });
    toast("Settings saved");
  };
  $("#run-auto").onclick = async () => {
    await api("/settings", { method: "PUT", body: collect() });
    startTask(api("/automation/run", { method: "POST" }), "Automation run finished");
  };
}

async function activityView(id) {
  const { tasks } = await api("/tasks");
  const selected = id ? (await api(`/tasks/${id}`)).task : null;
  view.innerHTML = `
    <div class="page-head"><div><h1>Activity</h1><p class="muted">Background work: searches, evaluations, drafts.</p></div></div>
    ${selected ? `<div class="card"><div class="page-head" style="margin:0 0 8px"><h2>${esc(selected.label)}</h2><span class="chip ${selected.status === "done" ? "good" : selected.status === "failed" ? "bad" : "warn"}">${esc(selected.status)}</span></div><pre class="log" id="log">${esc(selected.log || "Waiting to start…")}</pre></div>` : ""}
    <div class="card">${
      tasks.length
        ? `<table><thead><tr><th>Task</th><th>Status</th><th>Started</th><th class="hide-sm">Finished</th></tr></thead><tbody>${tasks
            .map((t) => `<tr class="clickable" data-href="#/activity/${t.id}"><td>${esc(t.label)}</td><td><span class="chip ${t.status === "done" ? "good" : t.status === "failed" ? "bad" : "warn"}">${esc(t.status)}</span></td><td class="small">${fmtTime(t.started_at || t.created_at)}</td><td class="small hide-sm">${fmtTime(t.finished_at)}</td></tr>`)
            .join("")}</tbody></table>`
        : `<p class="muted">Nothing has run yet.</p>`
    }</div>`;
  const log = $("#log");
  if (log) log.scrollTop = log.scrollHeight;
  if (selected && (selected.status === "running" || selected.status === "queued")) {
    clearTimeout(activityTimer);
    activityTimer = setTimeout(() => location.hash === `#/activity/${id}` && activityView(id), 2500);
  }
}
let activityTimer;

// ------------------------------------------------------------ routing & auth
async function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  const [section, id] = hash.split("/");
  document.querySelectorAll(".sidebar nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === (section || "dashboard")));
  try {
    if (!section) await dashboard();
    else if (section === "jobs") await (id ? jobDetail(id) : jobsView());
    else if (section === "applications") await (id ? applicationDetail(id) : applicationsView());
    else if (section === "profile") await profileView();
    else if (section === "settings") await settingsView();
    else if (section === "activity") await activityView(id);
    else await dashboard();
  } catch (e) {
    if (e.message !== "Not signed in") view.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`;
  }
}

view.addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-href]");
  if (row && !e.target.closest("a, button")) location.hash = row.dataset.href;
});

function showLogin(hint) {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  if (hint) $("#login-hint").textContent = hint;
  $("#login-password").focus();
}

$("#login-form").onsubmit = async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("#login-password").value }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return ($("#login-error").textContent = data.error || "Sign-in failed");
  $("#login-password").value = "";
  boot();
};
$("#logout").onclick = async () => {
  await fetch("/api/logout", { method: "POST" });
  showLogin();
};

async function boot() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me.passwordSet) return showLogin("This server has no APP_PASSWORD yet. Set it in Railway → Variables, then reload.");
  if (!me.authed) return showLogin();
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  window.onhashchange = route;
  route();
  pollTasks();
}
boot();

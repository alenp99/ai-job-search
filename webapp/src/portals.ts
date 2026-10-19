import path from "node:path";
import { parse } from "node-html-parser";
import { PORTALS_DIR } from "./config";

export function htmlToText(html: string): string {
  const root = parse(html);
  root.querySelectorAll("script, style, noscript, svg, nav, footer, header, iframe").forEach((n) => n.remove());
  // Hidden elements are a known prompt-injection vector in postings.
  root.querySelectorAll("[hidden], [aria-hidden=true]").forEach((n) => n.remove());
  const main = root.querySelector("main") ?? root.querySelector("article") ?? root.querySelector("body") ?? root;
  return main.structuredText
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, arr) => l || arr[i - 1])
    .join("\n")
    .trim();
}

/** A search hit as every portal CLI emits it (normalized). */
export interface PortalResult {
  portal: string;
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  date: string | null;
  deadline: string | null;
  url: string | null;
}

export interface SearchSettings {
  queries: string[];
  jobage: number;
  limitPerQuery: number;
  portals: Record<string, boolean>;
  linkedinLocation: string;
  linkedinRemote: "" | "remote" | "hybrid" | "onsite";
  freehireCountries: string;
}

export const PORTALS: Record<string, { label: string; region: string; host: string }> = {
  "linkedin-search": { label: "LinkedIn", region: "Global", host: "linkedin.com" },
  "freehire-search": { label: "freehire.me", region: "Global (tech)", host: "freehire.me" },
  "jobindex-search": { label: "Jobindex", region: "Denmark", host: "jobindex.dk" },
  "jobnet-search": { label: "Jobnet", region: "Denmark", host: "jobnet.dk" },
  "jobbank-search": { label: "Akademikernes Jobbank", region: "Denmark", host: "jobbank.dk" },
  "jobdanmark-search": { label: "Jobdanmark", region: "Denmark", host: "jobdanmark.dk" },
};

export const DEFAULT_SEARCH: SearchSettings = {
  queries: [],
  jobage: 14,
  limitPerQuery: 15,
  portals: { "linkedin-search": true, "freehire-search": true },
  linkedinLocation: "",
  linkedinRemote: "",
  freehireCountries: "",
};

const LINKEDIN_AGES = [1, 7, 14, 30];
const JOBINDEX_AGES = [1, 7, 14, 30];

function nearestAge(days: number, allowed: number[]): number {
  return allowed.find((a) => a >= days) ?? allowed[allowed.length - 1];
}

function sinceDate(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

/** Build the documented CLI flags for one portal + query (see each portal's SKILL.md). */
function searchArgs(portal: string, q: string, s: SearchSettings): string[] | null {
  const n = String(s.limitPerQuery);
  switch (portal) {
    case "linkedin-search": {
      if (!s.linkedinLocation.trim()) return null;
      const args = ["-q", q, "-l", s.linkedinLocation, "--jobage", String(nearestAge(s.jobage, LINKEDIN_AGES)), "--limit", n];
      if (s.linkedinRemote) args.push("--remote", s.linkedinRemote);
      return args;
    }
    case "freehire-search": {
      const args = ["-q", q, "--jobage", String(s.jobage), "--limit", n, "--no-description"];
      if (s.freehireCountries.trim()) args.push("--country", s.freehireCountries.replace(/\s/g, ""));
      return args;
    }
    case "jobindex-search":
      return ["--query", q, "--jobage", String(nearestAge(s.jobage, JOBINDEX_AGES)), "--sort", "date", "--limit", n];
    case "jobnet-search":
      return ["--search-string", q, "--order", "PublicationDate", "--limit", n];
    case "jobbank-search":
      return ["--key", q, "--since", sinceDate(s.jobage), "--limit", n];
    case "jobdanmark-search":
      return ["--text", q, "--limit", n];
    default:
      return null;
  }
}

async function runCli(portal: string, args: string[], timeoutMs = 90_000): Promise<unknown> {
  const cwd = path.join(PORTALS_DIR, portal, "cli");
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args, "--format", "json"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) {
    throw new Error(`${portal} exited ${code}: ${(err || out).trim().slice(0, 400)}`);
  }
  const parsed = JSON.parse(out);
  // Some CLIs wrap their payload as {ok, data}.
  return parsed && typeof parsed === "object" && "ok" in parsed && "data" in parsed ? parsed.data : parsed;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function searchPortal(portal: string, query: string, s: SearchSettings): Promise<PortalResult[]> {
  const args = searchArgs(portal, query, s);
  if (!args) return [];
  const data = (await runCli(portal, ["search", ...args])) as { results?: Record<string, unknown>[] };
  const cutoff = sinceDate(s.jobage);
  return (data.results ?? [])
    .map((r) => ({
      portal,
      id: String(r.id ?? r.slug ?? r.url ?? ""),
      title: str(r.title) ?? "",
      company: str(r.company),
      location: str(r.location),
      date: str(r.date),
      deadline: str(r.deadline),
      url: str(r.url),
    }))
    .filter((r) => r.title && r.id)
    // Portals without a recency flag get the client-side date filter.
    .filter((r) => !r.date || r.date >= cutoff);
}

/** Full posting text via the portal's own `detail` command. */
export async function portalDetail(portal: string, id: string): Promise<{ text: string; deadline: string | null; url: string | null }> {
  const data = (await runCli(portal, ["detail", id])) as Record<string, unknown>;
  // Most CLIs return the posting at the top level; tolerate a {result} wrapper.
  const job = (typeof data.title === "string" ? data : (data.result ?? data)) as Record<string, unknown>;
  const raw = str(job.description) ?? str(job.text) ?? str(job.body) ?? "";
  const desc = /<\w+[^>]*>/.test(raw) ? htmlToText(raw) : raw;
  const employer = job.employer as { name?: string } | undefined;
  const application = job.application as { deadlineDate?: string } | undefined;
  const deadline = str(job.deadline) ?? str(application?.deadlineDate)?.slice(0, 10) ?? null;
  const header = [
    `Title: ${str(job.title) ?? ""}`,
    `Company: ${str(job.company) ?? str(employer?.name) ?? ""}`,
    `Location: ${str(job.location) ?? ""}`,
    deadline ? `Deadline: ${deadline}` : "",
    job.contact ? `Contact: ${typeof job.contact === "string" ? job.contact : JSON.stringify(job.contact)}` : "",
  ].filter(Boolean);
  return { text: `${header.join("\n")}\n\n${desc}`.trim(), deadline, url: str(job.url) };
}

/** Which installed portal (if any) owns this URL's host. */
export function portalForUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [name, p] of Object.entries(PORTALS)) {
    if (host === p.host || host.endsWith(`.${p.host}`)) return name;
  }
  return null;
}

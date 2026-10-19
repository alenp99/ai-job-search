import { mkdtemp, rm, writeFile, readFile, symlink, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { COVER_DIR } from "./config";

export interface CompileResult {
  ok: boolean;
  pdf: Uint8Array | null;
  pages: number | null;
  text: string;
  log: string;
}

async function run(cmd: string[], cwd: string, timeoutMs = 180_000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, out: out + err };
}

/** The lines of a TeX log that explain a failure, not the whole 2000-line log. */
function errorExcerpt(log: string): string {
  const lines = log.split("\n");
  const hits: string[] = [];
  lines.forEach((l, i) => {
    if (l.startsWith("!") || /Error|Undefined control sequence|Emergency stop/.test(l)) {
      hits.push(lines.slice(Math.max(0, i - 2), i + 6).join("\n"));
    }
  });
  return (hits.length ? hits.slice(0, 6).join("\n...\n") : lines.slice(-40).join("\n")).slice(0, 6000);
}

/**
 * Compile one document. CV uses lualatex (moderncv + fontawesome5); the cover letter
 * uses xelatex because cover.cls needs fontspec and the bundled OpenFonts.
 */
export async function compile(kind: "cv" | "cover", tex: string): Promise<CompileResult> {
  const dir = await mkdtemp(path.join(tmpdir(), `ajs-${kind}-`));
  try {
    const file = kind === "cv" ? "cv.tex" : "cover.tex";
    await writeFile(path.join(dir, file), tex);
    if (kind === "cover") {
      await copyFile(path.join(COVER_DIR, "cover.cls"), path.join(dir, "cover.cls"));
      await symlink(path.join(COVER_DIR, "OpenFonts"), path.join(dir, "OpenFonts"));
    }
    const engine = kind === "cv" ? "lualatex" : "xelatex";
    // shell-escape stays off (TeX Live default): drafted LaTeX is model output.
    const res = await run([engine, "-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", file], dir);
    const pdfPath = path.join(dir, file.replace(/\.tex$/, ".pdf"));
    let pdf: Uint8Array | null = null;
    try {
      pdf = new Uint8Array(await readFile(pdfPath));
    } catch {
      pdf = null;
    }
    if (res.code !== 0 || !pdf) {
      let log = res.out;
      try {
        log = await readFile(path.join(dir, file.replace(/\.tex$/, ".log")), "utf8");
      } catch {}
      return { ok: false, pdf: null, pages: null, text: "", log: errorExcerpt(log) };
    }
    const info = await run(["pdfinfo", pdfPath], dir, 30_000);
    const pages = Number(/Pages:\s+(\d+)/.exec(info.out)?.[1] ?? NaN);
    const txt = await run(["pdftotext", "-layout", "-enc", "UTF-8", pdfPath, "-"], dir, 30_000);
    return { ok: true, pdf, pages: Number.isFinite(pages) ? pages : null, text: txt.out, log: "" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function latexAvailable(): Promise<boolean> {
  try {
    const r = await run(["lualatex", "--version"], tmpdir(), 10_000);
    return r.code === 0;
  } catch {
    return false;
  }
}

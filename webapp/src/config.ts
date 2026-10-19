import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Repo root holds the framework's skills, portal CLIs and LaTeX templates.
export const REPO_ROOT = process.env.REPO_ROOT ?? path.resolve(here, "../..");
export const DATA_DIR = process.env.DATA_DIR ?? path.join(REPO_ROOT, "webapp", ".data");
export const PUBLIC_DIR = path.resolve(here, "../public");

export const PORT = Number(process.env.PORT ?? 8080);
export const APP_PASSWORD = process.env.APP_PASSWORD ?? "";
export const SESSION_SECRET = process.env.SESSION_SECRET ?? APP_PASSWORD;

export const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";

export const SKILLS_DIR = path.join(REPO_ROOT, ".claude", "skills", "job-application-assistant");
export const PORTALS_DIR = path.join(REPO_ROOT, ".agents", "skills");
export const CV_TEMPLATE = path.join(REPO_ROOT, "cv", "main_example.tex");
export const COVER_DIR = path.join(REPO_ROOT, "cover_letters");

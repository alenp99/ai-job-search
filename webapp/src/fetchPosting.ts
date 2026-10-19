import { htmlToText, portalDetail, portalForUrl } from "./portals";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9,da;q=0.8",
};

/** Retrieve a posting: portal CLI first, then a browser-header fetch (per 09-web-research.md). */
export async function fetchPosting(url: string): Promise<{ text: string; portal: string | null; deadline: string | null }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http(s) URLs are supported.");

  const portal = portalForUrl(url);
  if (portal) {
    try {
      const d = await portalDetail(portal, url);
      if (d.text.length > 200) return { text: d.text, portal, deadline: d.deadline };
    } catch {
      // fall through to a direct fetch
    }
  }

  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Fetching the posting failed with HTTP ${res.status}. Paste the posting text instead.`);
  const text = htmlToText(await res.text());
  if (text.length < 200) throw new Error("The page had almost no readable text (likely a login wall or a JS-only page). Paste the posting text instead.");
  return { text: text.slice(0, 60_000), portal, deadline: null };
}

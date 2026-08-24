import psl from "psl";
import { cacheIcon } from "./browser-data";

const TIMEOUT_MS = 5000;
// Multi-resolution .ico files are routinely larger than they look: a 200 KB cap
// rejected real icons at 285 KB. Still bounded, because these are embedded as
// data URIs in a cache.
const MAX_BYTES = 400 * 1024;
const MAX_HTML = 200 * 1024;

const ICON_LINK = /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/gi;
const HREF = /href=["']([^"']+)["']/i;
const SIZES = /sizes=["'](\d+)/i;

/** The first failure that was not simply "this site has no icon". */
let lastError: string | undefined;

async function get(url: string): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    return response.ok ? response : undefined;
  } catch (error) {
    // A timeout or a refused connection is ordinary. Anything else is worth
    // reporting: swallowing every error made a broken run look like a run where
    // no site happened to have an icon.
    const message = error instanceof Error ? error.message : String(error);
    if (!lastError && !/abort|ENOTFOUND|ECONNREFUSED|certificate|fetch failed/i.test(message)) {
      lastError = message;
    }
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Download a URL only if it really is an image, small enough to embed. */
async function asDataUri(url: string): Promise<string | undefined> {
  const response = await get(url);
  const type = response?.headers.get("content-type")?.split(";")[0] ?? "";
  if (!response || !type.startsWith("image/")) return undefined;

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES) return undefined;
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * Many sites answer /favicon.ico with their single-page app shell rather than an
 * icon, so fall back to whatever the page itself declares. Largest declared size
 * wins, since these render on a retina list row.
 */
async function iconFromPage(domain: string): Promise<string | undefined> {
  const response = await get(`https://${domain}/`);
  if (!response) return undefined;

  const html = (await response.text()).slice(0, MAX_HTML);
  let best: string | undefined;
  let bestSize = -1;

  for (const tag of html.match(ICON_LINK) ?? []) {
    const href = tag.match(HREF)?.[1];
    if (!href) continue;
    const size = Number(tag.match(SIZES)?.[1] ?? 0);
    if (size > bestSize) {
      bestSize = size;
      best = href;
    }
  }
  if (!best) return undefined;

  try {
    return await asDataUri(new URL(best, `https://${domain}/`).toString());
  } catch {
    return undefined;
  }
}

/**
 * Icons are fetched from each site directly rather than from a favicon service.
 * A service would learn every domain the user holds an account for; asking a
 * site for its own icon tells it nothing ordinary browsing would not.
 */
export async function fetchIcon(domain: string): Promise<string | undefined> {
  const direct = (await asDataUri(`https://${domain}/favicon.ico`)) ?? (await iconFromPage(domain));
  if (direct) return direct;

  // A login host often serves no icon of its own while the site root does, so
  // fall back to the registrable domain — the same brand, not a sibling
  // service, which is what made borrowing wrong in the first place.
  const parsed = psl.parse(domain) as { domain?: string | null };
  const apex = parsed.domain?.toLowerCase();
  if (!apex || apex === domain) return undefined;
  return (await asDataUri(`https://${apex}/favicon.ico`)) ?? (await iconFromPage(apex));
}

/**
 * Fetch icons for hosts that have none, recording misses so a dead end is not
 * re-probed. Bounded by the caller to what is on screen.
 */
export async function fetchMissing(hosts: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  await Promise.all(
    hosts
      .filter((h) => psl.isValid(h))
      .map(async (host) => {
        const icon = await fetchIcon(host).catch(() => undefined);
        cacheIcon(host, icon ?? "");
        if (icon) found.set(host, icon);
      }),
  );
  return found;
}

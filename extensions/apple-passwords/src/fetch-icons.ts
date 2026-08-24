import { showToast, Toast } from "@raycast/api";
import { indexedDomains } from "./utils";
import psl from "psl";
import { cacheIcon, knownMisses, missingIcons } from "./browser-data";

const CONCURRENCY = 6;
const TIMEOUT_MS = 5000;
// Multi-resolution .ico files are routinely larger than they look: a 200 KB cap
// rejected real icons at 285 KB. Still bounded, because these are embedded as
// data URIs in a cache.
const MAX_BYTES = 400 * 1024;
const MAX_HTML = 200 * 1024;

const ICON_LINK = /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/gi;
const HREF = /href=["']([^"']+)["']/i;
const SIZES = /sizes=["'](\d+)/i;

async function get(url: string): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    return response.ok ? response : undefined;
  } catch {
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
async function fetchIcon(domain: string): Promise<string | undefined> {
  return (await asDataUri(`https://${domain}/favicon.ico`)) ?? (await iconFromPage(domain));
}

export default async function Command() {
  const known = indexedDomains();
  if (!known.length) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Nothing to fetch yet",
      message: "Search for a few sites first, then run this again.",
    });
    return;
  }

  // Credentials are stored against app identifiers too ("telegram.messenger"),
  // which are not hostnames and would each burn a connection timeout.
  const domains = (await missingIcons(known)).filter((d) => psl.isValid(d));
  if (!domains.length) {
    // "Nothing to fetch" is not the same as "everything has an icon": a site
    // that was checked and had none stays blank until it is worth retrying.
    const misses = knownMisses(known);
    await showToast({
      style: Toast.Style.Success,
      title: misses
        ? `Nothing left to fetch — ${misses} site${misses === 1 ? " has" : "s have"} no icon`
        : "Every known site has an icon",
    });
    return;
  }

  const toast = await showToast({
    style: Toast.Style.Animated,
    title: `Fetching ${domains.length} icon${domains.length === 1 ? "" : "s"}…`,
  });

  let cursor = 0;
  let found = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, domains.length) }, async () => {
      while (cursor < domains.length) {
        const domain = domains[cursor++];
        const icon = await fetchIcon(domain);
        // Record misses too, as an empty entry, so a site with no reachable icon
        // is not re-probed on every run.
        cacheIcon(domain, icon ?? "");
        if (icon) found++;
      }
    }),
  );

  toast.style = found ? Toast.Style.Success : Toast.Style.Failure;
  toast.title = `${found} of ${domains.length} icon${domains.length === 1 ? "" : "s"} fetched`;
}

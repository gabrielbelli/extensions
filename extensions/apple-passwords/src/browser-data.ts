import { execFile } from "child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import psl from "psl";
import { Cache } from "@raycast/api";

const execFileAsync = promisify(execFile);
const APW_CONFIG = join(homedir(), ".apw", "config.json");

/** Chromium data directories, keyed by the browser ids apw uses. */
const DATA_DIRS: Record<string, string> = {
  chromium: "Chromium",
  edge: "Microsoft Edge",
  brave: "BraveSoftware/Brave-Browser",
  chrome: "Google/Chrome",
};

/**
 * The profile apw is actually driving. Its config records the path it copied
 * Apple's extension out of, which names the exact browser *and* profile, so we
 * follow that rather than guessing. The browser id is the fallback.
 */
export function browserProfileDir(): string | undefined {
  try {
    const config = JSON.parse(readFileSync(APW_CONFIG, "utf8")) as {
      extensionPath?: string;
      browser?: string;
    };

    const marker = config.extensionPath?.indexOf("/Extensions/") ?? -1;
    if (config.extensionPath && marker > 0) {
      const dir = config.extensionPath.slice(0, marker);
      if (existsSync(join(dir, "History"))) return dir;
    }

    const dataDir = DATA_DIRS[config.browser ?? ""];
    if (dataDir) {
      const candidate = join(homedir(), "Library", "Application Support", dataDir, "Default");
      if (existsSync(join(candidate, "History"))) return candidate;
    }
  } catch {
    /* no apw config yet */
  }

  for (const dataDir of Object.values(DATA_DIRS)) {
    const candidate = join(homedir(), "Library", "Application Support", dataDir, "Default");
    if (existsSync(join(candidate, "History"))) return candidate;
  }
  return undefined;
}

/**
 * Browsers hold an exclusive lock on these SQLite files while running, so query
 * a throwaway copy instead of the live database.
 */
async function querySnapshot<T>(dbPath: string, sql: string): Promise<T[]> {
  if (!existsSync(dbPath)) return [];
  const dir = mkdtempSync(join(tmpdir(), "apw-idx-"));
  const copy = join(dir, "snapshot.db");
  try {
    copyFileSync(dbPath, copy);
    const { stdout } = await execFileAsync("/usr/bin/sqlite3", ["-json", "-readonly", copy, sql], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.trim() ? (JSON.parse(stdout) as T[]) : [];
  } catch {
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Favicons already cached by the browser, as data URIs. Using the local cache
 * keeps the account list off the network — asking a favicon service for each
 * domain would disclose exactly which sites the user holds credentials for.
 */
const iconCache = new Map<string, string>();

// Icons fetched from the network by the opt-in command, kept separately so they
// survive a restart and are never confused with what the browser already had.
const fetchedIcons = new Cache({ namespace: "icons" });

/** Sites rebrand, so a fetched icon is due for another look eventually. */
const REFRESH_AFTER_MS = 1000 * 60 * 60 * 24 * 90;

/** An empty dataUri records "looked, found nothing" so it is not re-probed. */
export function cacheIcon(domain: string, dataUri: string): void {
  fetchedIcons.set(domain.toLowerCase(), JSON.stringify({ uri: dataUri, at: Date.now() }));
}

function readFetched(key: string): { uri: string; at: number } | undefined {
  const raw = fetchedIcons.get(key);
  if (!raw) return undefined;
  if (!raw.startsWith("{")) return { uri: raw, at: 0 }; // stored before icons were dated
  try {
    return JSON.parse(raw) as { uri: string; at: number };
  } catch {
    return undefined;
  }
}

/**
 * The fetch command's work list: sites with no icon at all, plus fetched ones
 * old enough to be worth rechecking. Icons the browser supplied are left out —
 * the browser refreshes those itself as you visit.
 */
export async function missingIcons(domains: string[]): Promise<string[]> {
  await favicons(domains);
  return domains.filter((domain) => {
    const key = domain.toLowerCase();
    if (iconCache.has(key)) return false;
    const fetched = readFetched(key);
    return !fetched || Date.now() - fetched.at > REFRESH_AFTER_MS;
  });
}

/** hostname and registrable domain -> icon id. Ids only; blobs on demand. */
let mappingPromise: Promise<Map<string, number>> | undefined;

/** Memoises the promise, not the result, so concurrent searches share one read. */
function loadMapping(profile: string): Promise<Map<string, number>> {
  return (mappingPromise ??= buildMapping(profile));
}

async function buildMapping(profile: string): Promise<Map<string, number>> {
  const mapping = new Map<string, number>();

  // Deliberately no join against favicon_bitmaps here. Each icon is mapped from
  // many page URLs, so joining duplicates every blob per mapping — on a normal
  // profile that turns ~1 MB of images into ~21 MB of hex and exhausts the
  // worker's heap. Ids are cheap; blobs are fetched only for what is asked for.
  const rows = await querySnapshot<{ page_url: string; icon_id: number }>(
    join(profile, "Favicons"),
    "SELECT page_url, icon_id FROM icon_mapping;",
  );

  for (const row of rows) {
    let host: string;
    try {
      host = new URL(row.page_url).hostname;
    } catch {
      continue;
    }
    const key = host.toLowerCase();
    const parsed = psl.parse(key) as { domain?: string | null };
    const domain = parsed.domain?.toLowerCase();

    // Key on the full hostname. Self-hosted setups put many unrelated services
    // on one registrable domain, and keying on the domain alone handed every
    // one of them whichever service's icon happened to be seen first.
    mapping.set(key, row.icon_id);

    // The apex, and only the apex, also stands in for hosts with no icon of
    // their own. Letting an arbitrary subdomain fill that role is what smeared
    // one service's icon across a whole personal domain.
    if (domain && (key === domain || key === `www.${domain}`)) mapping.set(domain, row.icon_id);
  }
  return mapping;
}

export async function favicons(domains: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!domains.length) return found;

  // No browser profile is not fatal: icons fetched by the opt-in command live in
  // their own cache and must still render.
  const profile = browserProfileDir();
  if (!profile) {
    collect(domains, found);
    return found;
  }

  const byDomain = await loadMapping(profile);
  // Several domains can share one icon id, so map id -> domains rather than
  // id -> domain, which silently dropped all but the last.
  const wanted = new Map<number, string[]>();
  for (const domain of domains) {
    const key = domain.toLowerCase();
    if (iconCache.has(key)) continue;
    const parsed = psl.parse(key) as { domain?: string | null };
    // Exact host first, then its registrable domain.
    const id = byDomain.get(key) ?? byDomain.get(parsed.domain?.toLowerCase() ?? "");
    if (id !== undefined) wanted.set(id, [...(wanted.get(id) ?? []), key]);
  }

  if (wanted.size) {
    // Only the handful of ids on screen, so every size can be read and the best
    // one chosen here rather than with a fragile GROUP BY.
    const rows = await querySnapshot<{ icon_id: number; width: number; image_data: string }>(
      join(profile, "Favicons"),
      `SELECT icon_id, width, hex(image_data) AS image_data
         FROM favicon_bitmaps
        WHERE icon_id IN (${[...wanted.keys()].join(",")})
          AND image_data IS NOT NULL AND length(image_data) > 0
          AND width <= 128;`,
    );

    const chosen = new Map<string, number>();
    for (const row of rows) {
      if (!row.image_data) continue;
      // Smallest icon that is still crisp on a retina list row.
      const score = row.width >= 32 ? row.width : 1000 - row.width;
      for (const domain of wanted.get(row.icon_id) ?? []) {
        if ((chosen.get(domain) ?? Infinity) <= score) continue;
        chosen.set(domain, score);
        iconCache.set(domain, `data:image/png;base64,${Buffer.from(row.image_data, "hex").toString("base64")}`);
      }
    }
  }

  collect(domains, found);
  return found;
}

function collect(domains: string[], into: Map<string, string>): void {
  for (const domain of domains) {
    const key = domain.toLowerCase();
    // An empty uri records a fetch that found nothing, so it is not retried
    // until the refresh window lapses.
    const uri = iconCache.get(key) || readFetched(key)?.uri;
    if (uri) into.set(key, uri);
  }
}

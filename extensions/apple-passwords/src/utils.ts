import { Cache, getFrontmostApplication, getPreferenceValues, PreferenceValues } from "@raycast/api";
import { runAppleScript } from "@raycast/utils";
import { execFile, spawn } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";
import psl from "psl";

export interface APWEntry {
  domain: string;
  username: string;
  title?: string;
  code?: string;
  hasOtp?: boolean;
  password?: string;
  source?: string;
  sites?: string[];
  highLevelDomain?: string;
}

export interface APWIndexEntry {
  domain: string;
  username: string;
  title?: string;
  sites?: string[];
  hasOtp: boolean;
  hits?: number;
}

export interface APWMsg {
  error?: string;
  status: number;
  results?: APWEntry[];
}

class BrowserError extends Error {
  constructor(browser: string) {
    super(`Browser not supported: ${browser}`);
  }
}

export const PREFERENCES = getPreferenceValues<PreferenceValues>();
const CLI_PATH = PREFERENCES.cliPathAPW || ["/opt/homebrew/bin/apw", "/usr/local/bin/apw"].find(existsSync) || "apw";
const CACHE_TIMEOUT = 1000 * 60 * parseInt(PREFERENCES.cacheTimeout || "0", 10);
const passwordCache = new Map<string, { password: string; expiresAt: number }>();

const indexCache = new Cache({ namespace: "index" });
const INDEX_KEY = "entries";

function readIndex(): APWIndexEntry[] {
  try {
    const raw = indexCache.get(INDEX_KEY);
    return raw ? (JSON.parse(raw) as APWIndexEntry[]) : [];
  } catch {
    return [];
  }
}

function relationshipRank(candidate: string, query: string): number {
  if (candidate === query) return 0;
  if (candidate.endsWith("." + query)) return 1;
  if (query.endsWith("." + candidate)) return 2;
  if (candidate.split(".").some((l) => l.startsWith(query))) return 3;
  // Label boundary, so "example.co" does not rank against "example.com".
  if (candidate.includes(`${query}.`)) return 4;
  return 5;
}

/** Match a hostname on label boundaries rather than as a loose substring. */
function hostMatch(host: string, query: string): boolean {
  const h = host.toLowerCase();
  return h === query || h.endsWith(`.${query}`) || h.startsWith(`${query}.`) || h.includes(`${query}.`);
}

function mergeToIndex(entries: APWIndexEntry[]): void {
  const byKey = new Map<string, APWIndexEntry>();
  for (const e of [...readIndex(), ...entries]) {
    const key = `${(e.username || "").toLowerCase()}\n${(e.domain || "").toLowerCase()}`;
    const saved = byKey.get(key);
    if (saved) {
      saved.sites = [...new Set([...(saved.sites || []), ...(e.sites || [])])];
      saved.hasOtp = saved.hasOtp || e.hasOtp;
    } else {
      byKey.set(key, { ...e });
    }
  }
  indexCache.set(INDEX_KEY, JSON.stringify([...byKey.values()]));
}

/** Distinct domains already known from lookups, used to scope icon fetching. */
export function indexedDomains(): string[] {
  return [
    ...new Set(
      readIndex()
        .map((e) => e.domain?.toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/**
 * An `@` anywhere makes it an account search; anything else searches sites.
 *
 * Without that split a site search also matched usernames, so looking up the
 * domain your email happens to live on returned nearly every account you own.
 *
 * A leading `@` is the useful shorthand — `@example.com` means "every account
 * on this address domain" — so it is stripped before matching rather than
 * treated as part of the username. apw itself cannot answer that question at
 * all (the helper only accepts per-site queries), which is why this rule lives
 * here, against the local recall index, instead of being mirrored in the CLI.
 */

export function searchIndex(query: string): APWIndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const byAccount = q.includes("@") && !q.includes("://") && q.length > 1;
  const needle = q.startsWith("@") ? q.slice(1) : q;

  const matches = readIndex().filter((e) =>
    byAccount
      ? (e.username || "").toLowerCase().includes(needle)
      : hostMatch(e.domain, q) ||
        (e.title || "").toLowerCase().includes(q) ||
        (e.sites || []).some((site) => hostMatch(site, q)),
  );

  return matches.sort((a, b) => {
    // Ranking by how the domain relates to the query is meaningless when the
    // query was an address, so fall straight through to usage there.
    if (!byAccount) {
      const rankDiff = relationshipRank(a.domain, q) - relationshipRank(b.domain, q);
      if (rankDiff !== 0) return rankDiff;
    }
    const hitsDiff = (b.hits || 0) - (a.hits || 0);
    return hitsDiff || a.domain.localeCompare(b.domain);
  });
}
const execFileAsync = promisify(execFile);

function execWithStdin(args: string[], input: string): Promise<APWMsg> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_PATH, args);
    child.on("error", reject);
    // A closed stdin would otherwise raise an unhandled EPIPE.
    child.stdin.on("error", () => {});
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("close", () => {
      const raw = stdout.trim() || stderr.trim();
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error(raw || "Unknown error"));
      }
    });
    child.stdin.write(input + "\n");
    child.stdin.end();
  });
}

export async function execAPWCommand(args: string[], stdin?: string): Promise<APWMsg> {
  const shouldCache = args[0] === "pw" && args[1] === "get" && args.length === 4 && CACHE_TIMEOUT > 0;
  const cacheKey = shouldCache ? `pw\0${args[2]}\0${args[3]}` : "";

  if (shouldCache) {
    const entry = passwordCache.get(cacheKey);
    if (entry && Date.now() < entry.expiresAt) {
      console.info("Cache hit: pw get");
      return { status: 0, results: [{ domain: args[2], username: args[3], password: entry.password }] };
    }
    if (entry) passwordCache.delete(cacheKey);
  }

  if (stdin !== undefined) return execWithStdin(args, stdin);

  try {
    const { stdout } = await execFileAsync(CLI_PATH, args, { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    const data = JSON.parse(stdout.trim()) as APWMsg;
    const password = data.results?.[0]?.password;
    if (data.status === 0 && shouldCache && password !== undefined) {
      passwordCache.set(cacheKey, { password, expiresAt: Date.now() + CACHE_TIMEOUT });
    }
    return data;
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
    if (!stderr) throw error;
    let message = stderr;
    let apwStatus: number | undefined;
    try {
      const parsed = JSON.parse(stderr) as APWMsg;
      message = parsed.error || stderr;
      apwStatus = parsed.status;
    } catch {
      /* not JSON */
    }
    throw Object.assign(new Error(message), { apwStatus });
  }
}

/**
 * Search by whatever the user typed. The helper only answers per-site queries,
 * so a shorthand word is turned into candidate hostnames and each is asked
 * directly — cheap enough (tens of milliseconds each) that no prebuilt index is
 * needed.
 */
/**
 * One call to the CLI, which owns candidate expansion, the recall index, the
 * account-vs-site rule and the one-time-code pairing. Previously this fanned
 * out up to sixteen subprocesses per keystroke and duplicated that logic here.
 */
export async function searchAPWEntries(query: string): Promise<APWEntry[]> {
  if (!query.trim()) return [];
  const result = await execAPWCommand(["find", query]);
  const entries = result.results ?? [];

  // The CLI remembers hostnames, which is all host expansion needs. Usernames
  // stay here, because an "@" search asks a question the CLI cannot answer:
  // its index holds no addresses.
  mergeToIndex(
    entries.map((entry) => ({
      domain: entry.highLevelDomain ?? entry.domain,
      username: entry.username,
      title: entry.title,
      sites: entry.sites,
      hasOtp: !!entry.hasOtp,
    })),
  );

  return entries;
}

export async function getAPWEntry(url: string, action: "otp" | "pw", username: string): Promise<APWEntry | undefined> {
  const result = await execAPWCommand(action === "pw" ? [action, "get", url, username] : [action, "get", url]);
  if (action === "pw") {
    const password = result.results?.[0]?.password;
    return password === undefined ? undefined : { domain: url, username, password };
  }
  // Matched on username alone: Apple returns a password against the host it was
  // saved on but a one-time code against the registrable domain, so comparing
  // the two silently found nothing and the code never reached the clipboard.
  return (result.results ?? []).find((entry) => entry.username === username);
}

const getBrowserCommand = (browserName: string) => {
  switch (browserName) {
    case "Safari":
    case "Webkit":
    case "Orion":
      return `tell application "${browserName}" to return URL of front document`;
    case "Google Chrome":
    case "Google Chrome Canary":
    case "Chromium":
    case "Brave":
    case "Arc":
      return `tell application "${browserName}" to return URL of active tab of front window`;
    default:
      throw new BrowserError(browserName);
  }
};

export const getActiveURL = async (): Promise<string> => {
  try {
    const frontmostApplication = await getFrontmostApplication();
    try {
      const res = await runAppleScript(getBrowserCommand(frontmostApplication.name));
      const parsed = psl.parse(new URL(res).hostname);
      if ("error" in parsed) {
        throw new Error(parsed.error.toString());
      }
      return parsed.domain || "";
    } catch (error) {
      if (error instanceof BrowserError) {
        console.warn(error.message);
        return "";
      }
      console.error("Application: " + frontmostApplication.name, error);
      return "";
    }
  } catch {
    return "";
  }
};

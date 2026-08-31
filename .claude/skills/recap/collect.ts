#!/usr/bin/env zx
// Recap fact collector. Gathers git + Claude-session + GitHub facts for a time
// window and prints one JSON object. Never renders a table -- the model does that.
//
// Run: zx ~/.claude/skills/recap/collect.ts [--since workday|24h|friday|<ISO>] [--author <email>]
//
// Requires RECAP_GIT_HOME -- the directory holding the user's git repos.
//
// cwd-independent by contract: nothing here reads process.cwd() to decide scope.

import { readdir, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";

// @ts-ignore
$.verbose = false;

const HOME = homedir();
const CLAUDE_PROJECTS = join(HOME, ".claude", "projects");
const HISTORY_FILE = join(HOME, ".claude", "history.jsonl");

// The root to scan for git repos. There is no default: guessing ~/projects
// produces a plausible-looking but silently incomplete recap for anyone who
// keeps their checkouts elsewhere. Fail loudly instead, on stderr, so stdout
// stays a pure JSON facts object on the success path.
function configError(error: string, message: string): never {
  console.error(JSON.stringify({ error, message }));
  process.exit(1);
}

const GIT_HOME = (process.env.RECAP_GIT_HOME ?? "").trim();

if (!GIT_HOME) {
  configError(
    "RECAP_GIT_HOME_NOT_SET",
    'RECAP_GIT_HOME is not set. Set it to the directory containing your git repositories, e.g. export RECAP_GIT_HOME="$HOME/projects"',
  );
}

if (!existsSync(GIT_HOME)) {
  configError(
    "RECAP_GIT_HOME_INVALID",
    `RECAP_GIT_HOME points at "${GIT_HOME}", which does not exist.`,
  );
}

const NUL = "\x00";
// git expands the literal text %x1f / %1f into this byte. A real NUL byte
// embedded in an argv string is truncated by execve, silently gutting the format.
const SEP = "\x1f";
const notes: string[] = [];

// ---------------------------------------------------------------- git helpers

// @ts-ignore
const gitRun = $({ timeout: "20s", nothrow: true, quiet: true });

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const r = await gitRun`git -C ${cwd} ${args}`;
    if (r.exitCode !== 0) return null;
    return r.stdout;
  } catch {
    return null;
  }
}

const lines = (s: string | null): string[] =>
  (s ?? "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

// ------------------------------------------------------------ window resolving

type Window = { since: Date; until: Date; label: string; spec: string };

function atHour(d: Date, hour: number): Date {
  const x = new Date(d);
  x.setHours(hour, 0, 0, 0);
  return x;
}

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function resolveWindow(spec: string, now: Date = new Date()): Window {
  const s = (spec || "workday").trim().toLowerCase();

  // duration: 90m / 24h / 3d
  const dur = s.match(/^(\d+)\s*([mhd])$/);
  if (dur) {
    const n = Number(dur[1]);
    const ms =
      dur[2] === "m"
        ? n * 60_000
        : dur[2] === "h"
          ? n * 3_600_000
          : n * 86_400_000;
    const since = new Date(now.getTime() - ms);
    return { since, until: now, label: `last ${n}${dur[2]}`, spec: s };
  }

  // named weekday: most recent such day strictly before today, at 10:00
  const dayIdx = DAY_NAMES.indexOf(s);
  if (dayIdx >= 0) {
    const d = new Date(now);
    do {
      d.setDate(d.getDate() - 1);
    } while (d.getDay() !== dayIdx);
    const since = atHour(d, 10);
    return {
      since,
      until: now,
      label: `since ${DAY_NAMES[dayIdx]} ${fmtDay(since)} 10:00`,
      spec: s,
    };
  }

  if (s === "workday" || s === "yesterday" || s === "") {
    // Walk back from yesterday until we land on Mon-Fri. Monday reaches Friday.
    const d = new Date(now);
    do {
      d.setDate(d.getDate() - 1);
    } while (d.getDay() === 0 || d.getDay() === 6);
    const since = atHour(d, 10);
    return {
      since,
      until: now,
      label: `since ${DAY_NAMES[d.getDay()]} ${fmtDay(since)} 10:00`,
      spec: "workday",
    };
  }

  const parsed = new Date(spec);
  if (!isNaN(parsed.getTime())) {
    return { since: parsed, until: now, label: `since ${spec}`, spec: s };
  }

  notes.push(`unrecognized --since "${spec}", fell back to workday`);
  return resolveWindow("workday", now);
}

// First table column. A window wider than 24h spans days, so a clock time is
// ambiguous -- show dd/mm. Within 24h the day is implied, so show hh:mm rounded
// to the nearest half hour ("approximate" is the point; exact minutes are noise).
const HALF_HOUR = 30 * 60_000;

function fmtRowTime(ms: number, windowSpanMs: number): string {
  if (!ms) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  if (windowSpanMs > 86_400_000) {
    const d = new Date(ms);
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}`;
  }
  const d = new Date(Math.round(ms / HALF_HOUR) * HALF_HOUR);
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// --------------------------------------------------------- claude session mining

type Session = {
  sessionId: string;
  file: string;
  cwd: string | null;
  branch: string | null;
  title: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  recap: string | null;
  from: string | null;
  to: string | null;
};

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const t = content
      .map((b: any) =>
        typeof b === "string" ? b : b && b.type === "text" ? b.text : "",
      )
      .filter(Boolean)
      .join(" ");
    return t || null;
  }
  return null;
}

const clip = (s: string | null, n: number): string | null =>
  s == null ? null : s.length > n ? s.slice(0, n).trimEnd() + "…" : s;

async function readSession(
  file: string,
  sinceMs: number,
): Promise<Session | null> {
  const out: Session = {
    sessionId: "",
    file,
    cwd: null,
    branch: null,
    title: null,
    firstPrompt: null,
    lastPrompt: null,
    recap: null,
    from: null,
    to: null,
  };

  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (line.length < 2) continue;
      // Cheap prefilter: message records carry "timestamp", titles carry "aiTitle".
      // Everything else is sidecar state we do not need.
      if (!line.includes('"timestamp"') && !line.includes('"aiTitle"'))
        continue;

      let r: any;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }

      if (r.type === "ai-title" && r.aiTitle) {
        out.title = String(r.aiTitle); // rewritten as the session evolves; last wins
        if (!out.sessionId && r.sessionId) out.sessionId = String(r.sessionId);
        continue;
      }

      if (r.sessionId && !out.sessionId) out.sessionId = String(r.sessionId);
      if (r.cwd) out.cwd = String(r.cwd);
      if (r.gitBranch) out.branch = String(r.gitBranch);

      if (r.timestamp) {
        const ts = String(r.timestamp);
        if (!out.from) out.from = ts;
        out.to = ts;
      }

      if (r.subtype === "away_summary" && r.content) {
        out.recap = clip(textOf(r.content) ?? String(r.content), 400);
      }

      // .type === "user" also matches tool results and slash-command echoes.
      // origin.kind === "human" is the reliable filter for a real prompt.
      if (r.type === "user" && r.origin && r.origin.kind === "human") {
        const t = textOf(r.message?.content);
        if (t) {
          if (!out.firstPrompt) out.firstPrompt = clip(t, 200);
          out.lastPrompt = clip(t, 200);
        }
      }
    }
  } catch {
    return null;
  } finally {
    rl.close();
  }

  if (!out.to) return null;
  if (new Date(out.to).getTime() < sinceMs) return null;
  return out;
}

async function collectSessions(sinceMs: number): Promise<Session[]> {
  if (!existsSync(CLAUDE_PROJECTS)) return [];
  const found: Session[] = [];
  let dirs: string[] = [];
  try {
    dirs = await readdir(CLAUDE_PROJECTS);
  } catch {
    return [];
  }

  for (const d of dirs) {
    const full = join(CLAUDE_PROJECTS, d);
    let entries: string[] = [];
    try {
      const st = await stat(full);
      if (!st.isDirectory()) continue;
      entries = await readdir(full);
    } catch {
      continue;
    }
    for (const f of entries) {
      // Top-level transcripts only. Subagent transcripts live one level deeper
      // in <session-uuid>/subagents/ and are noise for a recap.
      if (!f.endsWith(".jsonl")) continue;
      const p = join(full, f);
      try {
        const st = await stat(p);
        if (!st.isFile()) continue;
        if (st.mtimeMs < sinceMs) continue; // mtime == last activity
      } catch {
        continue;
      }
      const s = await readSession(p, sinceMs);
      if (s) found.push(s);
    }
  }

  // Resumed/forked sessions inherit the parent's aiTitle; collapse them.
  const seen = new Map<string, Session>();
  for (const s of found) {
    const key = `${s.title ?? s.sessionId}${NUL}${s.cwd ?? ""}`;
    const prev = seen.get(key);
    if (!prev || (s.to ?? "") > (prev.to ?? "")) seen.set(key, s);
  }
  return [...seen.values()].sort((a, b) =>
    (b.to ?? "").localeCompare(a.to ?? ""),
  );
}

async function collectHistoryIndex(
  sinceMs: number,
): Promise<Record<string, number>> {
  const byProject: Record<string, number> = {};
  if (!existsSync(HISTORY_FILE)) return byProject;
  const rl = createInterface({
    input: createReadStream(HISTORY_FILE, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (line.length < 2) continue;
      let r: any;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      // timestamp here is epoch MILLISECONDS, unlike the ISO strings in sessions.
      if (
        typeof r.timestamp === "number" &&
        r.timestamp >= sinceMs &&
        r.project
      ) {
        byProject[r.project] = (byProject[r.project] ?? 0) + 1;
      }
    }
  } catch {
    /* ignore */
  } finally {
    rl.close();
  }
  return byProject;
}

// -------------------------------------------------------------- repo discovery

const isRepoRoot = (p: string): boolean => existsSync(join(p, ".git"));

// A linked worktree has its own .git file and would otherwise be reported as a
// separate repo named after the worktree dir. --git-common-dir always points at
// the MAIN repo's .git, so it collapses worktree -> owning repo.
async function mainRepoRoot(p: string): Promise<string | null> {
  const common = await git(p, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const c = (common ?? "").trim();
  if (!c) return null;
  return c.endsWith("/.git") ? c.slice(0, -"/.git".length) : dirname(c);
}

async function discoverRepos(sessionPaths: string[]): Promise<string[]> {
  const roots = new Set<string>();

  // GIT_HOME is proven to exist at startup, so no existsSync guard here.
  let entries: string[] = [];
  try {
    entries = await readdir(GIT_HOME);
  } catch {
    /* ignore */
  }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    const p = join(GIT_HOME, e);
    try {
      if (!(await stat(p)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (isRepoRoot(p)) {
      roots.add(p);
      continue;
    }
    // one level down catches nested repos (e.g. black-glass-gm/www)
    try {
      for (const sub of await readdir(p)) {
        const q = join(p, sub);
        try {
          if ((await stat(q)).isDirectory() && isRepoRoot(q)) roots.add(q);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Repos active in Claude history but living outside ~/projects.
  for (const p of sessionPaths) {
    if (!p || !existsSync(p)) continue;
    const top = await git(p, ["rev-parse", "--show-toplevel"]);
    const t = (top ?? "").trim();
    if (t) roots.add(t);
  }

  const canonical = new Set<string>();
  for (const r of roots) canonical.add((await mainRepoRoot(r)) ?? r);
  return [...canonical].sort();
}

// An uncommitted change is only recap-worthy if it was touched in the window;
// otherwise a tree left dirty months ago reports as fresh work every morning.
async function latestTouch(
  wt: string,
  porcelainLines: string[],
): Promise<number> {
  let newest = 0;
  for (const l of porcelainLines.slice(0, 60)) {
    let rel = l.slice(3).trim();
    const arrow = rel.indexOf(" -> ");
    if (arrow >= 0) rel = rel.slice(arrow + 4); // renames: "old -> new"
    if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
    if (!rel) continue;
    try {
      const m = (await stat(join(wt, rel))).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      continue; // deleted file cannot be dated; keep looking
    }
  }
  return newest;
}

type Worktree = { path: string; branch: string | null };

async function worktreesOf(repo: string): Promise<Worktree[]> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  if (!out) return [{ path: repo, branch: null }];
  const wts: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const l of out.split("\n")) {
    if (l.startsWith("worktree ")) {
      if (cur) wts.push(cur);
      cur = { path: l.slice("worktree ".length).trim(), branch: null };
    } else if (l.startsWith("branch ") && cur) {
      cur.branch = l
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    }
  }
  if (cur) wts.push(cur);
  return wts.length ? wts : [{ path: repo, branch: null }];
}

// --------------------------------------------------------------- per-repo facts

type RawCommit = {
  sha: string;
  short: string;
  aI: string;
  cI: string;
  ae: string;
  an: string;
  subject: string;
};

async function defaultBranchOf(repo: string): Promise<string> {
  const sym = await git(repo, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  const s = (sym ?? "").trim();
  if (s) return s.replace(/^refs\/remotes\/origin\//, "");
  for (const c of ["main", "master"]) {
    const v = await git(repo, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${c}`,
    ]);
    if (v && v.trim()) return c;
  }
  return "main";
}

const LOG_FMT = "--pretty=format:%H%x1f%h%x1f%aI%x1f%cI%x1f%ae%x1f%an%x1f%s";

function parseLog(raw: string | null): RawCommit[] {
  return lines(raw)
    .map((l) => {
      // A subject can contain almost anything; never assume all 7 fields split.
      const f = l.split(SEP);
      return {
        sha: f[0] ?? "",
        short: f[1] ?? "",
        aI: f[2] ?? "",
        cI: f[3] ?? "",
        ae: f[4] ?? "",
        an: f[5] ?? "",
        subject: f[6] ?? "",
      } as RawCommit;
    })
    .filter((c) => c.sha && c.aI);
}

async function branchCommits(
  repo: string,
  branch: string,
  base: string,
  sinceISO: string,
): Promise<RawCommit[]> {
  // --since filters COMMITTER date, which is always >= author date, so it is a
  // safe superset prefilter. Author-date filtering happens in JS below.
  const args =
    branch === base
      ? ["log", branch, `--since=${sinceISO}`, LOG_FMT]
      : ["log", branch, "--not", base, `--since=${sinceISO}`, LOG_FMT];
  return parseLog(await git(repo, args));
}

// ------------------------------------------------------------------- PR lookup

type Pr = {
  number: number;
  url: string;
  state: string;
  title: string;
  head: string;
  updatedAt: string;
};

// `gh search prs` cannot return headRefName, so there is no way to join its
// results to a branch. `gh pr list --repo` can, and only repos with activity in
// the window are queried -- usually one or two.
// Memoize the PROMISE, not the boolean: repos are scanned concurrently, and a
// flag set before the await lets every other caller race past with a stale false.
let ghProbe: Promise<boolean> | null = null;

function ghAvailable(): Promise<boolean> {
  if (!ghProbe) {
    ghProbe = (async () => {
      // @ts-ignore
      const r = await $({
        timeout: "15s",
        nothrow: true,
        quiet: true,
      })`gh auth status`;
      const ok = r.exitCode === 0;
      if (!ok)
        notes.push("gh unavailable (not authenticated) - pr column is empty");
      return ok;
    })();
  }
  return ghProbe;
}

function nameWithOwner(remoteUrl: string): string | null {
  const u = remoteUrl.trim();
  const m = u.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function fetchPrsForRepo(repo: string, sinceMs: number): Promise<Pr[]> {
  if (!(await ghAvailable())) return [];
  const remote = await git(repo, ["remote", "get-url", "origin"]);
  if (!remote) return [];
  const slug = nameWithOwner(remote);
  if (!slug) return [];

  // @ts-ignore
  const ghRun = $({ timeout: "25s", nothrow: true, quiet: true });
  const args = [
    "pr",
    "list",
    "--repo",
    slug,
    "--author",
    "@me",
    "--state",
    "all",
    "--limit",
    "50",
    "--json",
    "number,url,state,title,headRefName,updatedAt",
  ];

  let r = await ghRun`gh ${args}`;
  if (r.exitCode !== 0) {
    // The active GITHUB_TOKEN may lack scopes the keyring token has.
    r = await ghRun`env -u GITHUB_TOKEN gh ${args}`;
  }
  if (r.exitCode !== 0) {
    notes.push(`gh pr list failed for ${slug}`);
    return [];
  }

  try {
    const raw = JSON.parse(r.stdout || "[]");
    // @ts-ignore
    return raw
      .map((p: any) => ({
        number: p.number,
        url: p.url,
        // gh pr list returns UPPERCASE state; gh search prs returns lowercase.
        state: String(p.state ?? "").toLowerCase(),
        title: p.title ?? "",
        head: p.headRefName ?? "",
        updatedAt: p.updatedAt ?? "",
      }))
      .filter(
        (p: Pr) => !p.updatedAt || new Date(p.updatedAt).getTime() >= sinceMs,
      );
  } catch {
    notes.push(`gh pr list returned unparseable output for ${slug}`);
    return [];
  }
}

// ------------------------------------------------------------------------ main

// @ts-ignore
const spec = String(argv.since ?? argv._[0] ?? "workday");
// --now exists so the weekend/Monday rollback is testable without waiting for Monday.
// @ts-ignore
const nowOverride = argv.now ? new Date(String(argv.now)) : new Date();
const win = resolveWindow(
  spec,
  isNaN(nowOverride.getTime()) ? new Date() : nowOverride,
);
const sinceMs = win.since.getTime();
const windowSpanMs = win.until.getTime() - win.since.getTime();
const sinceISO = win.since.toISOString();

// @ts-ignore
let author = String(argv.author ?? "");
if (!author) {
  // @ts-ignore
  const e = await $({
    nothrow: true,
    quiet: true,
  })`git config --global user.email`;
  author = (e.stdout ?? "").trim() || "mh@spektr.com";
}

const sessions = await collectSessions(sinceMs);
const historyIndex = await collectHistoryIndex(sinceMs);

const sessionPaths = [
  ...new Set([
    ...(sessions.map((s) => s.cwd).filter(Boolean) as string[]),
    ...Object.keys(historyIndex),
  ]),
];

const repos = await discoverRepos(sessionPaths);

type Row = {
  time: string;
  time_ms: number;
  repo: string;
  branch: string;
  worktree: string | null;
  pr: { number: number; url: string; state: string } | null;
  commits: {
    sha: string;
    subject: string;
    authored: string;
    committed: string;
  }[];
  commit_count: number;
  rebased: number;
  wip: { files: number; stat: string } | null;
  checkouts: number;
  session_titles: string[];
};

const rows: Row[] = [];
let rebasedTotal = 0;

async function processRepo(repo: string): Promise<Row[]> {
  const out: Row[] = [];
  const name = basename(repo);
  const wts = await worktreesOf(repo);

  const candidates = new Set<string>();
  const checkoutCounts = new Map<string, number>();
  const checkoutAt = new Map<string, number>();
  const wipAt = new Map<string, number>();
  const wipByBranch = new Map<string, { files: number; stat: string }>();
  const wtOfBranch = new Map<string, string>();

  // branches with recent tip activity
  const refs = await git(repo, [
    "for-each-ref",
    "refs/heads",
    "--sort=-committerdate",
    "--format=%(refname:short)%1f%(committerdate:unix)",
  ]);
  for (const l of lines(refs)) {
    const [b, unix] = l.split(SEP);
    if (b && Number(unix) * 1000 >= sinceMs) candidates.add(b);
  }

  // Reflog is PER-WORKTREE: scanning only the main checkout misses worktree work.
  for (const wt of wts) {
    const rl = await git(wt.path, [
      "reflog",
      "--date=unix",
      `--since=${sinceISO}`,
    ]);
    for (const l of lines(rl)) {
      const m = l.match(/checkout: moving from (\S+) to (\S+)/);
      if (!m) continue;
      const [, from, to] = m;
      if (from === to) continue; // rebase emits self-checkouts
      if (/^[0-9a-f]{7,40}$/.test(to)) continue; // detached HEAD hop
      candidates.add(to);
      checkoutCounts.set(to, (checkoutCounts.get(to) ?? 0) + 1);
      const when = l.match(/HEAD@\{(\d+)\}/);
      if (when) {
        const ms = Number(when[1]) * 1000;
        if (ms > (checkoutAt.get(to) ?? 0)) checkoutAt.set(to, ms);
      }
    }

    if (wt.branch) {
      candidates.add(wt.branch);
      wtOfBranch.set(wt.branch, wt.path);
      const porcelain = await git(wt.path, ["status", "--porcelain"]);
      const changedLines = lines(porcelain);
      const touched =
        changedLines.length > 0 ? await latestTouch(wt.path, changedLines) : 0;
      if (touched >= sinceMs) {
        wipAt.set(wt.branch, touched);
        const shortstat = await git(wt.path, ["diff", "--shortstat"]);
        wipByBranch.set(wt.branch, {
          files: changedLines.length,
          stat: (shortstat ?? "").trim(),
        });
      }
    }
  }

  // A PR can surface a branch with no local activity at all. Only repos that
  // already show signal are queried, so this is 1-2 gh calls in practice.
  const hasLocalSignal =
    candidates.size > 0 ||
    sessions.some(
      (s) => s.cwd && (s.cwd === repo || s.cwd.startsWith(repo + "/")),
    );
  const repoPrs = hasLocalSignal ? await fetchPrsForRepo(repo, sinceMs) : [];
  for (const p of repoPrs) if (p.head) candidates.add(p.head);

  const repoSessions = sessions.filter(
    (s) => s.cwd && (s.cwd === repo || s.cwd.startsWith(repo + "/")),
  );
  for (const s of repoSessions) if (s.branch) candidates.add(s.branch);

  if (candidates.size === 0 && repoPrs.length === 0) return out;
  const base = await defaultBranchOf(repo);

  for (const branch of candidates) {
    const raw = await branchCommits(repo, branch, base, sinceISO);
    const mine = raw.filter(
      (c) => c.ae === author || c.ae.includes(author) || c.an === author,
    );

    // Author date is the truth. A rebase rewrites committer date, which is how
    // commits from days ago masquerade as today's work.
    const fresh = mine.filter((c) => new Date(c.aI).getTime() >= sinceMs);
    const rebased = mine.filter((c) => new Date(c.aI).getTime() < sinceMs);
    rebasedTotal += rebased.length;

    const wip = wipByBranch.get(branch) ?? null;
    const checkouts = checkoutCounts.get(branch) ?? 0;
    const titles = [
      ...new Set(
        repoSessions
          .filter((s) => s.branch === branch)
          .map((s) => s.title)
          .filter(Boolean) as string[],
      ),
    ];
    const pr = repoPrs.find((p) => p.head === branch) ?? null;

    // A lone checkout is too weak to be work -- you merely visited the branch.
    const signal =
      fresh.length > 0 ||
      wip !== null ||
      titles.length > 0 ||
      pr !== null ||
      checkouts >= 2;
    if (!signal) continue;

    // The row's moment = the newest thing that happened on this branch.
    const stamps = [
      ...fresh.map((c) => new Date(c.aI).getTime()),
      ...repoSessions
        .filter((x) => x.branch === branch)
        .map((x) => (x.to ? new Date(x.to).getTime() : 0)),
      wipAt.get(branch) ?? 0,
      checkoutAt.get(branch) ?? 0,
      pr?.updatedAt ? new Date(pr.updatedAt).getTime() : 0,
    ].filter((n) => Number.isFinite(n) && n > 0);
    const timeMs = stamps.length ? Math.max(...stamps) : 0;

    out.push({
      time: fmtRowTime(timeMs, windowSpanMs),
      time_ms: timeMs,
      repo: name,
      branch,
      worktree: wtOfBranch.get(branch) ?? null,
      pr: pr ? { number: pr.number, url: pr.url, state: pr.state } : null,
      commits: fresh.slice(0, 25).map((c) => ({
        sha: c.short,
        subject: c.subject,
        authored: c.aI,
        committed: c.cI,
      })),
      commit_count: fresh.length,
      rebased: rebased.length,
      wip,
      checkouts,
      session_titles: titles,
    });
  }
  return out;
}

// Repos are independent; a serial scan of ~24 of them dominates runtime.
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

for (const chunk of await mapPool(repos, 8, processRepo)) rows.push(...chunk);

if (rebasedTotal > 0) {
  notes.push(
    `${rebasedTotal} commit(s) in the window are rebase artifacts (committed recently, authored earlier) — not new work`,
  );
}

rows.sort((a, b) => {
  const score = (r: Row) =>
    (r.wip ? 3 : 0) +
    (r.commit_count > 0 ? 2 : 0) +
    (r.session_titles.length ? 1 : 0);
  return (
    score(b) - score(a) ||
    b.time_ms - a.time_ms ||
    b.commit_count - a.commit_count
  );
});

const result = {
  window: {
    since: sinceISO,
    until: win.until.toISOString(),
    label: win.label,
    spec: win.spec,
  },
  author,
  rows,
  sessions: sessions.slice(0, 25).map((s) => ({
    title: s.title,
    cwd: s.cwd,
    branch: s.branch,
    from: s.from,
    to: s.to,
    first_prompt: s.firstPrompt,
    last_prompt: s.lastPrompt,
    recap: s.recap,
  })),
  prompt_counts: historyIndex,
  notes,
};

console.log(JSON.stringify(result, null, 2));

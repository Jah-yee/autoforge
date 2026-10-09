/** Mirrors the daemon's IssueStatus (src/serve/state.ts). */
export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "publishing"
  | "published"
  | "no_changes"
  | "failed"
  | "timed_out"
  | "discarded";

/** One entry of the daemon's GET /runs, as passed on by the Rust side. */
export type Run = {
  issueId: string;
  identifier: string;
  status: RunStatus;
  repo: string;
  ref: string;
  queuedAt: string;
  updatedAt: string;
  prUrl?: string;
  issueUrl?: string;
};

/** Serialised by src-tauri/src/status.rs (AppState). */
export type AppState =
  | { kind: "daemonNotRunning" }
  | { kind: "unreachable"; reason: string }
  | { kind: "unauthorized" }
  | { kind: "ok"; runs: Run[] };

/** Serialised by src-tauri/src/status.rs (Snapshot). lastOkAt is epoch ms of the last good poll. */
export type Snapshot = { state: AppState; lastOkAt: number | null };

export type Groups = { awaiting: Run[]; running: Run[]; queued: Run[]; recent: Run[] };

export const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Awaiting approval",
  publishing: "Publishing",
  published: "Published",
  no_changes: "No changes",
  failed: "Failed",
  timed_out: "Timed out",
  discarded: "Discarded",
};

const FINISHED: RunStatus[] = ["published", "no_changes", "failed", "timed_out", "discarded"];
const WEEK = 7 * 86_400_000;
const RECENT_LIMIT = 20;

/** Epoch ms, 0 when unreadable, so comparators never return NaN. */
const ms = (iso: string) => Date.parse(iso) || 0;
const newestFirst = (a: Run, b: Run) => ms(b.updatedAt) - ms(a.updatedAt);

/** The popover's groups. Statuses this app does not know (a newer daemon) are left out. */
export function groupRuns(runs: Run[], now: number): Groups {
  const having = (...statuses: RunStatus[]) => runs.filter((r) => statuses.includes(r.status));
  return {
    awaiting: having("awaiting_approval").sort(newestFirst),
    running: having("running", "publishing").sort(newestFirst),
    // Array.prototype.sort is stable, so equal queuedAt keeps the daemon's order.
    queued: having("queued").sort((a, b) => ms(a.queuedAt) - ms(b.queuedAt)),
    recent: having(...FINISHED)
      .filter((r) => now - Date.parse(r.updatedAt) <= WEEK)
      .sort(newestFirst)
      .slice(0, RECENT_LIMIT),
  };
}

export function relativeTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (!(s >= 5) || !Number.isFinite(s)) return "just now"; // also NaN, Infinity and a clock behind the daemon's
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function prLabel(prUrl: string): string {
  const n = /\/pull\/(\d+)/.exec(prUrl)?.[1];
  return n ? `PR #${n}` : "PR";
}

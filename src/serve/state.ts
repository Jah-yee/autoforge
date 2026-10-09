import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RunResult } from "../run.js";

export type IssueStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "publishing"
  | "published"
  | "no_changes"
  | "failed"
  | "timed_out"
  | "discarded";

export type IssueEntry = {
  /** For example "ENG-123". */
  identifier: string;
  status: IssueStatus;
  repo: string;
  ref: string;
  feedback?: string;
  interruptions: number;
  /** Linear time of the latest queued or result comment; commands must be newer. */
  lastResultCommentAt?: string;
  handledCommentIds: string[];
  /** From slice 1; the patch is stored separately. */
  run?: Omit<RunResult, "patch" | "logs">;
  prUrl?: string;
  /** When the issue last joined the queue. The queue runs oldest first. */
  queuedAt: string;
  /** A "waiting" comment was already posted for this queued issue. */
  waiting?: "docker" | "limit";
  updatedAt: string;
};

export type OutboxItem = { issueId: string; body: string; gate: boolean; attempts: number };

export type State = {
  version: 1;
  viewerId: string;
  /** Linear time; advanced only after a successful poll. */
  cursor: string;
  dailyRuns: { date: string; count: number };
  /** Keyed by Linear issue id. */
  issues: Record<string, IssueEntry>;
  /** Issue id to its sorted labels when the "no repo" comment was posted. */
  noRoute: Record<string, string>;
  /** Comments that failed to post, retried on the next tick. */
  outbox: OutboxItem[];
};

const DAY = 86_400_000;

export function freshState(now: Date): State {
  return {
    version: 1,
    viewerId: "",
    cursor: new Date(now.getTime() - DAY).toISOString(),
    dailyRuns: { date: "", count: 0 },
    issues: {},
    noRoute: {},
    outbox: [],
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isState(s: unknown): s is State {
  return (
    isObject(s) &&
    s.version === 1 &&
    typeof s.viewerId === "string" &&
    typeof s.cursor === "string" &&
    isObject(s.dailyRuns) &&
    isObject(s.noRoute) &&
    Array.isArray(s.outbox) &&
    isObject(s.issues) &&
    Object.values(s.issues).every(
      (e) =>
        isObject(e) &&
        typeof e.status === "string" &&
        typeof e.queuedAt === "string" &&
        typeof e.updatedAt === "string" &&
        Array.isArray(e.handledCommentIds),
    )
  );
}

/** An unreadable or invalid state.json is renamed to state.json.corrupt-<time>. */
export async function loadState(
  dir: string,
  now: Date,
): Promise<{ state: State; corruptPath?: string }> {
  const path = join(dir, "state.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: freshState(now) };
    throw e;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isState(parsed)) return { state: parsed };
  } catch {
    // handled below
  }
  const corruptPath = `${path}.corrupt-${now.toISOString().replace(/[:.]/g, "-")}`;
  await rename(path, corruptPath);
  return { state: freshState(now), corruptPath };
}

/** Write to a temp file in the same directory with mode 600, fsync, rename. */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(text);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export async function saveState(dir: string, state: State): Promise<void> {
  await writeFileAtomic(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

function patchPath(dir: string, runId: string): string {
  if (!/^[\w-]+$/.test(runId)) throw new Error(`invalid run id: ${runId}`);
  return join(dir, "patches", `${runId}.patch`);
}

export async function writePatch(dir: string, runId: string, patch: string): Promise<void> {
  const file = patchPath(dir, runId);
  await mkdir(join(dir, "patches"), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, patch);
}

export async function readPatch(dir: string, runId: string): Promise<string | null> {
  try {
    return await readFile(patchPath(dir, runId), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function deletePatch(dir: string, runId: string): Promise<void> {
  await rm(patchPath(dir, runId), { force: true });
}

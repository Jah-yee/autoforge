import { randomUUID } from "node:crypto";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

export type LockOptions = {
  /** The pid written to the lock. Tests pass other live pids to play several starters. */
  pid?: number;
  /** Test seam: awaited between steps to force an interleaving. */
  pause?: (step: "read") => Promise<void>;
};

const BUSY_TRIES = 40;
const BUSY_MS = 50;

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;
const readPid = async (path: string) => {
  const text = await readFile(path, "utf8").catch((e: unknown) => {
    if (code(e) === "ENOENT") return null;
    throw e;
  });
  return text === null ? null : /^\d+$/.test(text) ? Number(text) : NaN;
};

/**
 * One daemon per state dir. Returns the pid of a live holder, or null once the lock is ours.
 * The lock appears with its pid already in it (hard link of a written temp file), and a stale
 * lock is taken over by renaming it aside, so only one starter can move the dead pid's file.
 */
export async function takeLock(path: string, o: LockOptions = {}): Promise<number | null> {
  const self = o.pid ?? process.pid;
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, String(self), { flag: "wx", mode: 0o600 });
  try {
    let busy = 0;
    for (;;) {
      try {
        await link(temp, path);
        return null;
      } catch (e) {
        if (code(e) !== "EEXIST") throw e;
      }
      const pid = await readPid(path);
      await o.pause?.("read");
      if (pid === null) continue; // removed meanwhile
      if (!(pid > 0)) {
        // Empty or garbled: links make that rare, but a hand-written or truncated lock waits.
        if (++busy >= BUSY_TRIES)
          throw new Error(
            `${path} stays empty or unreadable; delete it if no autoforge serve is running.`,
          );
        await sleep(BUSY_MS);
        continue;
      }
      // ponytail: a pid reused after a reboot keeps a dead daemon's lock looking live, so serve
      // refuses to start; delete serve.lock by hand. A boot id in the lock would close that.
      if (pid === self || alive(pid)) return pid;
      const aside = `${path}.stale-${randomUUID()}`;
      try {
        await rename(path, aside);
      } catch (e) {
        if (code(e) === "ENOENT") continue; // another starter moved it
        throw e;
      }
      // We may have moved a racer's fresh lock instead of the dead one: put it back. If a third
      // starter linked a lock in the meantime, the racer's backstop (lockHeld) stops it.
      if ((await readPid(aside)) !== pid)
        await link(aside, path).catch((e: unknown) => {
          if (code(e) !== "EEXIST") throw e;
        });
      await rm(aside, { force: true });
    }
  } finally {
    await rm(temp, { force: true });
  }
}

/** True while the lock names `pid`. Serve checks it every poll and stops when it is false. */
export async function lockHeld(path: string, pid = process.pid): Promise<boolean> {
  return (await readPid(path)) === pid;
}

export async function releaseLock(path: string, pid = process.pid): Promise<void> {
  // ponytail: read-then-unlink is not atomic. If, between the two calls, a starter that saw an
  // older dead pid moves our lock aside, we unlink nothing and it restores our lock, which the
  // next start finds dead and takes over. If a third starter links its lock in that same gap,
  // we unlink that one and the third's backstop (lockHeld) stops it.
  if (await lockHeld(path, pid)) await rm(path, { force: true });
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return code(e) === "EPERM"; // exists, owned by someone else
  }
}

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockHeld, releaseLock, takeLock } from "../../src/serve/lock.js";

const lockIn = async () => join(await mkdtemp(join(tmpdir(), "autoforge-lock-")), "serve.lock");
const deadPid = () => spawnSync("true").pid!;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// Live pids that are not ours, so several in-process callers can play separate starters.
const sleepers: ChildProcess[] = [];
let pids: number[] = [];
beforeAll(() => {
  for (let i = 0; i < 8; i++) sleepers.push(spawn("sleep", ["60"], { stdio: "ignore" }));
  pids = sleepers.map((c) => c.pid!);
});
afterAll(() => sleepers.forEach((c) => c.kill()));

describe("serve.lock", () => {
  it("a starter that saw the stale pid does not delete the winner's fresh lock", async () => {
    const lock = await lockIn();
    await writeFile(lock, String(deadPid()));
    let resume!: () => void;
    const gate = new Promise<void>((r) => (resume = r));
    let readStale!: () => void;
    const bRead = new Promise<void>((r) => (readStale = r));
    // B reads the dead pid, then stalls until A has taken the lock over.
    const b = takeLock(lock, {
      pid: pids[1],
      pause: async () => {
        readStale();
        await gate;
      },
    });
    await bRead;
    expect(await takeLock(lock, { pid: pids[0] })).toBeNull();
    resume();
    expect(await b).toBe(pids[0]);
    expect(await readFile(lock, "utf8")).toBe(String(pids[0]));
  });

  it("of 8 starters that all saw the stale pid, exactly one wins", async () => {
    for (let round = 0; round < 1; round++) {
      const lock = await lockIn();
      await writeFile(lock, String(deadPid()));
      // Every starter reads the dead pid and stalls; then they resume one at a time, in a
      // shuffled order, each after the previous one settled.
      const order = [...pids].sort(() => Math.random() - 0.5);
      const gates = new Map(order.map((pid) => [pid, deferred()]));
      const reads = new Map(order.map((pid) => [pid, deferred()]));
      const taking = order.map((pid) => {
        let first = true;
        return takeLock(lock, {
          pid,
          pause: async () => {
            if (!first) return;
            first = false;
            reads.get(pid)!.resolve();
            await gates.get(pid)!.promise;
          },
        });
      });
      await Promise.all([...reads.values()].map((r) => r.promise));
      const results: (number | null)[] = [];
      for (const [i, pid] of order.entries()) {
        gates.get(pid)!.resolve();
        results.push(await taking[i]!);
      }
      const winners = order.filter((_, i) => results[i] === null);
      expect(winners, `round ${round}`).toEqual([order[0]]);
      expect(results.slice(1)).toEqual(Array(7).fill(order[0]));
      expect(await readFile(lock, "utf8")).toBe(String(order[0]));
      expect(await readdir(join(lock, ".."))).toEqual(["serve.lock"]);
    }
  });

  it("waits on an empty lock (a writer mid-write) and refuses once it names a live pid", async () => {
    const lock = await lockIn();
    await writeFile(lock, "");
    const taking = takeLock(lock, { pid: pids[0] });
    await sleep(150);
    expect(await readFile(lock, "utf8")).toBe("");
    await writeFile(lock, String(pids[1]));
    expect(await taking).toBe(pids[1]);
    expect(await readFile(lock, "utf8")).toBe(String(pids[1]));
  });

  it("refuses a lock that stays empty, without deleting it", async () => {
    const lock = await lockIn();
    await writeFile(lock, "");
    await expect(takeLock(lock, { pid: pids[0], busyTries: 3, busyMs: 1 })).rejects.toThrow(
      /serve\.lock .*empty/,
    );
    expect(existsSync(lock)).toBe(true);
  });

  it("gives up on a dangling symlink at the lock path instead of spinning", async () => {
    const lock = await lockIn();
    await symlink(join(lock, "..", "nowhere"), lock);
    await expect(takeLock(lock, { pid: pids[0], busyTries: 3, busyMs: 1 })).rejects.toThrow(
      /serve\.lock .*unreadable/,
    );
  });

  it("treats a lock holding our own pid as stale (pid reuse after a reboot)", async () => {
    const lock = await lockIn();
    await writeFile(lock, ` ${pids[0]}\n`);
    expect(await takeLock(lock, { pid: pids[0] })).toBeNull();
    expect(await readFile(lock, "utf8")).toBe(String(pids[0]));
  });

  it("release leaves a lock that holds another pid", async () => {
    const lock = await lockIn();
    expect(await takeLock(lock, { pid: pids[0] })).toBeNull();
    await writeFile(lock, String(pids[1]));
    await releaseLock(lock, pids[0]);
    expect(await readFile(lock, "utf8")).toBe(String(pids[1]));
    await releaseLock(lock, pids[1]);
    expect(existsSync(lock)).toBe(false);
  });

  it("lockHeld is true only while the lock names us", async () => {
    const lock = await lockIn();
    expect(await lockHeld(lock, pids[0])).toBe(false);
    await takeLock(lock, { pid: pids[0] });
    expect(await lockHeld(lock, pids[0])).toBe(true);
    await writeFile(lock, String(pids[1]));
    expect(await lockHeld(lock, pids[0])).toBe(false);
  });
});

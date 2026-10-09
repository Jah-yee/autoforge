import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proc } from "../src/proc.js";

/** Runs git with a clean env (no inherited GIT_DIR from hooks) and throws on failure. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" };
  const r = await proc("git", args, { cwd, env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const commit = (cwd: string, msg: string) =>
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg);

export type BareRepo = { bare: string; mainSha: string; featureSha: string };

/** A bare repo with hello.txt on main, plus a feature branch adding feature.txt. */
export async function makeBareRepo(): Promise<BareRepo> {
  const root = await mkdtemp(join(tmpdir(), "autoforge-repo-"));
  const work = join(root, "work");
  const bare = join(root, "origin.git");
  await mkdir(work);
  await git(work, "init", "-q", "-b", "main");
  await writeFile(join(work, "hello.txt"), "hello\n");
  await git(work, "add", "-A");
  await commit(work, "init");
  const mainSha = await git(work, "rev-parse", "HEAD");
  await git(work, "checkout", "-qb", "feature");
  await writeFile(join(work, "feature.txt"), "feature\n");
  await git(work, "add", "-A");
  await commit(work, "feature");
  const featureSha = await git(work, "rev-parse", "HEAD");
  await git(work, "checkout", "-q", "main");
  await git(root, "clone", "-q", "--bare", work, bare);
  await git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  return { bare, mainSha, featureSha };
}

/** Adds a commit to main in the bare repo, as if a teammate pushed. */
export async function advanceMain(bare: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "autoforge-advance-"));
  await git(root, "clone", "-q", bare, "w");
  const w = join(root, "w");
  await writeFile(join(w, "other.txt"), "other\n");
  await git(w, "add", "-A");
  await commit(w, "other");
  await git(w, "push", "-q", "origin", "main");
}

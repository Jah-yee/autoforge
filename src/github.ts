import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proc } from "./proc.js";
import { makeRedactor } from "./redact.js";
import type { RunResult } from "./run.js";

export type PublishErrorCode =
  | "nothing_to_publish"
  | "fetch_failed"
  | "apply_failed"
  | "branch_exists"
  | "push_failed"
  | "github_api_error"
  | "invalid_result"
  | "aborted";

export class PublishError extends Error {
  override name = "PublishError";

  constructor(
    readonly code: PublishErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type PublishOptions = {
  /** "owner/name" */
  repo: string;
  /** Needs contents:write and pull_requests:write. Only used on the host. */
  token: string;
  base?: string;
  branch?: string;
  title?: string;
  body?: string;
  draft?: boolean;
  author?: { name: string; email: string };
  force?: boolean;
  /** Defaults to https://github.com/<repo>.git */
  gitUrl?: string;
  /** Defaults to https://api.github.com */
  apiUrl?: string;
  fetch?: typeof fetch;
  /** Stops git and the API request. A publish stopped this way throws code "aborted". */
  signal?: AbortSignal;
};

/** Applies a run's patch onto its base commit, pushes a branch and opens a pull request. */
export async function publishToGitHub(
  result: RunResult,
  o: PublishOptions,
): Promise<{ prUrl: string; branch: string; commitSha: string }> {
  if (result.status !== "changed" || !result.patch || !result.baseSha) {
    throw new PublishError(
      "nothing_to_publish",
      `run status is "${result.status}"; only "changed" runs can be published`,
    );
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(result.baseSha)) {
    throw new PublishError("invalid_result", "result.baseSha is not a commit sha");
  }
  const firstLine = result.task.split("\n")[0]?.trim() ?? "";
  const branch = o.branch ?? `autoforge/${slug(firstLine)}-${result.id.slice(0, 8)}`;
  if (branch.startsWith("-") || !/^[\w./-]+$/.test(branch)) {
    throw new TypeError(`invalid branch name: ${branch}`);
  }
  const title = o.title ?? firstLine.slice(0, 72);
  const body = o.body ?? `${result.task}\n\n---\nOpened by autoforge.`;
  const author = o.author ?? { name: "autoforge", email: "autoforge@users.noreply.github.com" };
  const base = o.base ?? result.repo.ref;
  const apiUrl = o.apiUrl ?? "https://api.github.com";
  const doFetch = o.fetch ?? fetch;
  const basic = Buffer.from(`x-access-token:${o.token}`).toString("base64");
  const header = `Authorization: Basic ${basic}`;
  const redact = makeRedactor([o.token, basic]);

  const dir = await mkdtemp(join(tmpdir(), "autoforge-publish-"));
  const cwd = join(dir, "repo");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dir,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    // Via env, not `-c` argv, so the token is not visible in the host process list.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: header,
  };
  const aborted = (detail = "") => new PublishError("aborted", `publishing was aborted${detail}`);
  const git = async (code: PublishErrorCode, ...args: string[]) => {
    const r = await proc("git", args, { cwd, env, signal: o.signal });
    if (o.signal?.aborted) throw aborted();
    if (r.exitCode !== 0) {
      throw new PublishError(code, redact(`git ${args.join(" ")} failed: ${r.stderr.trim()}`));
    }
    return r.stdout.trim();
  };

  try {
    await mkdir(cwd);
    await git("fetch_failed", "init", "-q");
    await git(
      "fetch_failed",
      "remote",
      "add",
      "origin",
      o.gitUrl ?? `https://github.com/${o.repo}.git`,
    );
    await git("fetch_failed", "fetch", "-q", "--depth", "1", "origin", result.baseSha);
    await git("fetch_failed", "checkout", "-q", "--detach", "FETCH_HEAD");

    const patchFile = join(dir, "change.patch");
    await writeFile(patchFile, result.patch);
    await git("apply_failed", "apply", "--binary", "--index", patchFile);
    await git(
      "apply_failed",
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "commit",
      "-q",
      "-m",
      title,
    );
    const commitSha = await git("apply_failed", "rev-parse", "HEAD");

    const existing = await git(
      "push_failed",
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${branch}`,
    );
    if (existing && !o.force) {
      throw new PublishError(
        "branch_exists",
        `branch ${branch} already exists; pass force: true to overwrite it`,
      );
    }
    await git(
      "push_failed",
      "push",
      "-q",
      ...(o.force ? ["--force"] : []),
      "origin",
      `HEAD:refs/heads/${branch}`,
    );

    const pushed = (detail: string) =>
      new PublishError(
        "github_api_error",
        redact(`GitHub API request failed (branch ${branch} was pushed): ${detail}`),
      );
    let res: Response;
    try {
      res = await doFetch(`${apiUrl}/repos/${o.repo}/pulls`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${o.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title, head: branch, base, body, draft: o.draft ?? true }),
        signal: o.signal,
      });
    } catch (e) {
      if (o.signal?.aborted) throw aborted(` (branch ${branch} was pushed)`);
      throw pushed(e instanceof Error ? e.message : String(e));
    }
    const text = await res.text().catch(() => "");
    if (o.signal?.aborted) throw aborted(` (branch ${branch} was pushed)`);
    if (!res.ok) throw pushed(`status ${res.status}: ${text}`);
    let prUrl: unknown;
    try {
      prUrl = (JSON.parse(text) as { html_url?: unknown }).html_url;
    } catch {
      throw pushed(`status ${res.status} with a non-JSON body`);
    }
    if (typeof prUrl !== "string") throw pushed(`status ${res.status} without html_url`);
    return { prUrl, branch, commitSha };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "task";

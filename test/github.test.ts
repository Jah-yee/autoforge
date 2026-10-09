import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { publishToGitHub, type PublishOptions } from "../src/github.js";
import { run, type RunResult } from "../src/index.js";
import { fakeAgent } from "./fake-agent.js";
import { advanceMain, git, makeBareRepo, type BareRepo } from "./helpers.js";
import { TempDirSandbox } from "./temp-dir-sandbox.js";

let repo: BareRepo;
let changed: RunResult;

beforeAll(async () => {
  repo = await makeBareRepo();
  changed = await run({
    repo: { url: repo.bare, ref: "main" },
    task: "Fix the greeting\n\nMore detail here.",
    agent: { command: fakeAgent("edit") },
    sandbox: new TempDirSandbox(),
  });
});

function stubFetch(status = 201) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const body = status < 300 ? { html_url: "https://github.com/o/r/pull/1" } : { message: "nope" };
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const opts = (extra: Partial<PublishOptions> = {}): PublishOptions => ({
  repo: "o/r",
  token: "tkn-123456",
  gitUrl: repo.bare,
  apiUrl: "https://api.example.test",
  fetch: stubFetch().fetch,
  ...extra,
});

describe("publishToGitHub", () => {
  it("pushes a branch with the patch and opens a draft PR", async () => {
    const { fetch, calls } = stubFetch();
    const out = await publishToGitHub(changed, opts({ fetch }));

    expect(out.prUrl).toBe("https://github.com/o/r/pull/1");
    expect(out.branch).toMatch(/^autoforge\/fix-the-greeting-[0-9a-f]{8}$/);
    expect(await git(repo.bare, "show", `${out.branch}:hello.txt`)).toBe("hello\nchanged");
    expect(await git(repo.bare, "rev-parse", out.branch)).toBe(out.commitSha);
    expect(await git(repo.bare, "log", "-1", "--format=%an <%ae>", out.branch)).toBe(
      "autoforge <autoforge@users.noreply.github.com>",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.test/repos/o/r/pulls");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer tkn-123456");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({
      title: "Fix the greeting",
      head: out.branch,
      base: "main",
      draft: true,
    });
    expect(body.body).toContain("More detail here.");
  });

  it("refuses to overwrite an existing branch unless forced", async () => {
    await publishToGitHub(changed, opts({ branch: "autoforge/fixed" }));
    await expect(
      publishToGitHub(changed, opts({ branch: "autoforge/fixed" })),
    ).rejects.toMatchObject({
      name: "PublishError",
      code: "branch_exists",
    });
    await expect(
      publishToGitHub(changed, opts({ branch: "autoforge/fixed", force: true })),
    ).resolves.toMatchObject({ branch: "autoforge/fixed" });
  });

  it("refuses results that are not 'changed' without touching GitHub", async () => {
    const { fetch, calls } = stubFetch();
    await expect(
      publishToGitHub({ ...changed, status: "no_changes", patch: "" }, opts({ fetch })),
    ).rejects.toMatchObject({ code: "nothing_to_publish" });
    expect(calls).toHaveLength(0);
  });

  it("reports API errors, and a forced retry succeeds after the branch was pushed", async () => {
    await expect(
      publishToGitHub(changed, opts({ branch: "autoforge/retry", fetch: stubFetch(422).fetch })),
    ).rejects.toMatchObject({ code: "github_api_error", message: expect.stringContaining("422") });
    await expect(
      publishToGitHub(changed, opts({ branch: "autoforge/retry", force: true })),
    ).resolves.toMatchObject({ branch: "autoforge/retry" });
  });

  it("still applies after main has moved on", async () => {
    const moving = await makeBareRepo();
    const result = await run({
      repo: { url: moving.bare, ref: "main" },
      task: "Edit hello",
      agent: { command: fakeAgent("edit") },
      sandbox: new TempDirSandbox(),
    });
    await advanceMain(moving.bare);
    const out = await publishToGitHub(result, opts({ gitUrl: moving.bare }));
    expect(await git(moving.bare, "rev-parse", `${out.branch}~1`)).toBe(moving.mainSha);
  });

  it("rejects a branch name that looks like a flag", async () => {
    await expect(publishToGitHub(changed, opts({ branch: "-x" }))).rejects.toThrow(TypeError);
  });

  it("never leaks the token into git failure messages", async () => {
    const err = await publishToGitHub(changed, opts({ gitUrl: "/nonexistent/repo.git" })).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "fetch_failed" });
    const b64 = Buffer.from("x-access-token:tkn-123456").toString("base64");
    for (const text of [String((err as Error).message), String((err as Error).stack)]) {
      expect(text).not.toContain("tkn-123456");
      expect(text).not.toContain(b64);
    }
  });

  it("redacts the token from the git command in a failure message", async () => {
    const hook = join(repo.bare, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const err = await publishToGitHub(changed, opts({ branch: "autoforge/tkn-123456" }))
      .catch((e: unknown) => e)
      .finally(() => rm(hook));
    expect(err).toMatchObject({ code: "push_failed" });
    expect(String((err as Error).message)).not.toContain("tkn-123456");
  });

  it("rejects a baseSha that is not a commit sha without touching GitHub", async () => {
    const { fetch, calls } = stubFetch();
    await expect(
      publishToGitHub(
        { ...changed, baseSha: "--upload-pack=touch /tmp/autoforge-pwned" },
        opts({ fetch }),
      ),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("wraps network failures after the push as github_api_error", async () => {
    const fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof globalThis.fetch;
    await expect(
      publishToGitHub(changed, opts({ branch: "autoforge/net", fetch })),
    ).rejects.toMatchObject({
      code: "github_api_error",
      message: expect.stringContaining("was pushed"),
    });
  });
});

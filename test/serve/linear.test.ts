import { describe, expect, it } from "vitest";
import { LinearClient, LinearError } from "../../src/serve/linear.js";

type Call = { url: string; headers: Headers; query: string; variables: Record<string, unknown> };

function stub(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push({ url: String(url), headers: new Headers(init.headers), ...body });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  const client = new LinearClient({
    apiKey: "lin_api_key",
    url: "https://linear.example.test/graphql",
    fetch,
  });
  return { client, calls };
}

const data = (d: unknown) => new Response(JSON.stringify({ data: d }), { status: 200 });

const rawIssue = (id: string, commentTimes: string[] = []) => ({
  id,
  identifier: "ENG-1",
  title: "T",
  description: null,
  url: "https://linear.app/acme/issue/ENG-1/t",
  updatedAt: "2026-10-09T12:00:00.000Z",
  assignee: { id: "u1" },
  state: { type: "unstarted" },
  team: { id: "t1", key: "ENG", name: "Engineering" },
  project: { id: "p1", name: "Docs" },
  labels: { nodes: [{ name: "autoforge" }] },
  comments: {
    nodes: commentTimes.map((createdAt, i) => ({
      id: `c${i}`,
      body: "hi",
      createdAt,
      user: { id: "u1", name: "Me" },
    })),
  },
});

const page = (nodes: unknown[], endCursor: string | null) =>
  data({ issues: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } });

describe("LinearClient", () => {
  it("sends the personal API key as is and returns the viewer", async () => {
    const { client, calls } = stub(data({ viewer: { id: "u1", name: "Me" } }));
    expect(await client.viewer()).toEqual({ id: "u1", name: "Me" });
    expect(calls[0]?.url).toBe("https://linear.example.test/graphql");
    expect(calls[0]?.headers.get("authorization")).toBe("lin_api_key");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
  });

  it("pages through changed issues and maps them, comments oldest first", async () => {
    const { client, calls } = stub(
      page([rawIssue("a", ["2026-10-09T12:00:02.000Z", "2026-10-09T12:00:01.000Z"])], "cursor-1"),
      page([rawIssue("b")], null),
    );
    const issues = await client.changedIssues("2026-10-09T00:00:00.000Z", []);
    expect(issues.map((i) => i.id)).toEqual(["a", "b"]);
    expect(issues[0]).toEqual({
      id: "a",
      identifier: "ENG-1",
      title: "T",
      description: null,
      url: "https://linear.app/acme/issue/ENG-1/t",
      updatedAt: "2026-10-09T12:00:00.000Z",
      assigneeId: "u1",
      stateType: "unstarted",
      labels: ["autoforge"],
      team: { id: "t1", key: "ENG", name: "Engineering" },
      project: { id: "p1", name: "Docs" },
      comments: [
        {
          id: "c1",
          body: "hi",
          createdAt: "2026-10-09T12:00:01.000Z",
          user: { id: "u1", name: "Me" },
        },
        {
          id: "c0",
          body: "hi",
          createdAt: "2026-10-09T12:00:02.000Z",
          user: { id: "u1", name: "Me" },
        },
      ],
    });
    expect(calls[0]?.variables).toEqual({
      after: null,
      filter: { assignee: { isMe: { eq: true } }, updatedAt: { gt: "2026-10-09T00:00:00.000Z" } },
    });
    expect(calls[1]?.variables.after).toBe("cursor-1");
    expect(calls[0]?.query).toMatch(/\burl\b/);
  });

  it("also asks for tracked issues by id", async () => {
    const { client, calls } = stub(page([], null));
    await client.changedIssues("2026-10-09T00:00:00.000Z", ["x", "y"]);
    expect(calls[0]?.variables.filter).toEqual({
      or: [
        { assignee: { isMe: { eq: true } }, updatedAt: { gt: "2026-10-09T00:00:00.000Z" } },
        { id: { in: ["x", "y"] } },
      ],
    });
  });

  it("turns GraphQL errors into LinearError", async () => {
    const { client } = stub(
      new Response(JSON.stringify({ errors: [{ message: "Authentication required" }] }), {
        status: 200,
      }),
    );
    await expect(client.viewer()).rejects.toThrow(
      new LinearError("Linear API error (status 200): Authentication required"),
    );
  });

  it("reads Retry-After from a rate-limited response", async () => {
    const { client } = stub(
      new Response(JSON.stringify({ errors: [{ message: "Rate limit exceeded" }] }), {
        status: 429,
        headers: { "Retry-After": "7" },
      }),
    );
    const err = await client.viewer().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinearError);
    expect(err).toMatchObject({ retryAfterMs: 7000, message: expect.stringContaining("429") });
  });

  it("wraps network failures and non-JSON bodies", async () => {
    const { client } = stub(new Error("ECONNRESET"), new Response("<html>", { status: 502 }));
    await expect(client.viewer()).rejects.toThrow(
      new LinearError("Linear request failed: ECONNRESET"),
    );
    await expect(client.viewer()).rejects.toThrow("Linear API error (status 502): <html>");
  });

  it("creates a comment and returns its id and time", async () => {
    const { client, calls } = stub(
      data({
        commentCreate: {
          success: true,
          comment: { id: "c9", createdAt: "2026-10-09T12:00:00.000Z" },
        },
      }),
    );
    expect(await client.comment("issue-1", "hello")).toEqual({
      id: "c9",
      createdAt: "2026-10-09T12:00:00.000Z",
    });
    expect(calls[0]?.variables).toEqual({ input: { issueId: "issue-1", body: "hello" } });
  });

  it("moves the issue to the first started state by position", async () => {
    const { client, calls } = stub(
      data({
        issue: {
          team: {
            states: {
              nodes: [
                { id: "s-review", position: 3 },
                { id: "s-progress", position: 1 },
              ],
            },
          },
        },
      }),
      data({ issueUpdate: { success: true } }),
    );
    await client.moveToStarted("issue-1");
    expect(calls[1]?.variables).toEqual({ id: "issue-1", stateId: "s-progress" });
  });

  it("attaches a URL to the issue", async () => {
    const { client, calls } = stub(data({ attachmentCreate: { success: true } }));
    await client.attachUrl("issue-1", "https://github.com/o/r/pull/1", "Draft PR");
    expect(calls[0]?.variables).toEqual({
      input: { issueId: "issue-1", url: "https://github.com/o/r/pull/1", title: "Draft PR" },
    });
  });

  it("stops paging when the cursor repeats", async () => {
    let n = 0;
    const client = new LinearClient({
      apiKey: "k",
      fetch: (async () => {
        n++;
        return page([rawIssue(`i${n}`)], "same");
      }) as unknown as typeof globalThis.fetch,
    });
    const issues = await client.changedIssues("2026-10-09T00:00:00.000Z", []);
    expect(n).toBeLessThanOrEqual(2);
    expect(issues.length).toBe(n);
  });

  it("gives up after 200 pages of ever-new cursors", async () => {
    let n = 0;
    const client = new LinearClient({
      apiKey: "k",
      fetch: (async () => page([], `c${++n}`)) as unknown as typeof globalThis.fetch,
    });
    await expect(client.changedIssues("2026-10-09T00:00:00.000Z", [])).rejects.toThrow(
      new LinearError("pagination did not terminate"),
    );
    expect(n).toBe(200);
  });

  it("asks for the last 100 comments and sorts them oldest first", async () => {
    const { client, calls } = stub(
      page([rawIssue("a", ["2026-10-09T12:00:03.000Z", "2026-10-09T12:00:01.000Z"])], null),
    );
    const [issue] = await client.changedIssues("2026-10-09T00:00:00.000Z", []);
    expect(calls[0]?.query).toContain("comments(last: 100)");
    expect(issue?.comments.map((c) => c.createdAt)).toEqual([
      "2026-10-09T12:00:01.000Z",
      "2026-10-09T12:00:03.000Z",
    ]);
  });

  it("turns a null JSON body into a LinearError", async () => {
    const { client } = stub(new Response("null", { status: 200 }));
    await expect(client.viewer()).rejects.toThrow(LinearError);
  });

  it("throws LinearError when a mutation reports success: false", async () => {
    const { client } = stub(
      data({ commentCreate: { success: false, comment: null } }),
      data({ attachmentCreate: { success: false } }),
      data({ issue: { team: { states: { nodes: [{ id: "s", position: 1 }] } } } }),
      data({ issueUpdate: { success: false } }),
    );
    await expect(client.comment("i", "b")).rejects.toThrow(LinearError);
    await expect(client.attachUrl("i", "u", "t")).rejects.toThrow(LinearError);
    await expect(client.moveToStarted("i")).rejects.toThrow(LinearError);
  });

  it("never leaks the API key into error messages", async () => {
    const key = "lin_api_SECRET_xyz";
    const responses: (Response | Error)[] = [
      new Error("ECONNRESET"),
      new Response("boom", { status: 500 }),
      new Response(JSON.stringify({ errors: [{ message: "bad" }] }), { status: 200 }),
    ];
    const client = new LinearClient({
      apiKey: key,
      fetch: (async () => {
        const r = responses.shift();
        if (r instanceof Error) throw r;
        return r;
      }) as unknown as typeof globalThis.fetch,
    });
    for (let i = 0; i < 3; i++) {
      const err = await client.viewer().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LinearError);
      expect((err as Error).message).not.toContain(key);
    }
  });
});

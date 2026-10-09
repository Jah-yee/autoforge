import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/serve/config.js";
import type { LinearIssue } from "../../src/serve/linear.js";
import { routeIssue } from "../../src/serve/route.js";

const issue = (fields: Partial<LinearIssue> = {}): LinearIssue => ({
  id: "i1",
  identifier: "OPS-1",
  title: "T",
  description: null,
  url: "https://linear.app/acme/issue/OPS-1/t",
  updatedAt: "2026-10-09T12:00:00.000Z",
  assigneeId: "me",
  stateType: "unstarted",
  labels: [],
  team: { id: "t-ops", key: "OPS", name: "Operations" },
  project: null,
  comments: [],
  ...fields,
});

const config = parseConfig({
  defaultRepo: "me/app",
  rules: [
    { linearProject: "Docs", repo: "me/docs@main" },
    { linearProject: "proj-42", repo: "me/p42" },
    { linearTeam: "ENG", repo: "me/app@develop", agent: { image: "my-agent" } },
    { linearTeam: "Platform", repo: "me/platform" },
  ],
  agent: { image: "base", command: ["agent"] },
});

const docs = { id: "p-docs", name: "Docs" };
const eng = { id: "t-eng", key: "ENG", name: "Engineering" };

const cases: [string, Partial<LinearIssue>, string, string, string][] = [
  [
    "a repo label wins over rules",
    { labels: ["repo:me/label@feat/x"], project: docs, team: eng },
    "me/label",
    "feat/x",
    "base",
  ],
  [
    "a repo label without a branch uses main",
    { labels: ["repo:me/label"] },
    "me/label",
    "main",
    "base",
  ],
  [
    "an invalid repo label falls through",
    { labels: ["repo:not a repo"], team: eng },
    "me/app",
    "develop",
    "my-agent",
  ],
  [
    "a label branch starting with - falls through",
    { labels: ["repo:me/x@-rf"], team: eng },
    "me/app",
    "develop",
    "my-agent",
  ],
  ["project by name", { project: docs }, "me/docs", "main", "base"],
  ["project by id", { project: { id: "proj-42", name: "Forty two" } }, "me/p42", "main", "base"],
  ["a project rule beats a team rule", { project: docs, team: eng }, "me/docs", "main", "base"],
  ["team by key", { team: eng }, "me/app", "develop", "my-agent"],
  [
    "team by name",
    { team: { id: "t-p", key: "PLT", name: "Platform" } },
    "me/platform",
    "main",
    "base",
  ],
  ["default repo", {}, "me/app", "main", "base"],
];

describe("routeIssue", () => {
  it.each(cases)("%s", (_name, fields, repo, ref, image) => {
    expect(routeIssue(issue(fields), config)).toMatchObject({ repo, ref, agent: { image } });
  });

  it("shallow-merges a rule's agent over the base agent", () => {
    expect(routeIssue(issue({ team: eng }), config)?.agent).toEqual({
      image: "my-agent",
      command: ["agent"],
      envFrom: [],
      timeoutMinutes: 30,
    });
  });

  it("returns null when nothing matches and there is no default repo", () => {
    const bare = parseConfig({ agent: { image: "base", command: ["agent"] } });
    expect(routeIssue(issue(), bare)).toBeNull();
  });
});

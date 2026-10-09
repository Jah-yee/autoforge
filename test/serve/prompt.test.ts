import { describe, expect, it } from "vitest";
import type { LinearComment, LinearIssue } from "../../src/serve/linear.js";
import { MARKER, parseCommand, renderTask } from "../../src/serve/prompt.js";

let seq = 0;
const comment = (body: string, user = { id: "me", name: "Mia" }): LinearComment => ({
  id: `c${++seq}`,
  body,
  createdAt: "2026-10-09T12:00:00.000Z",
  user,
});

const issue = (fields: Partial<LinearIssue> = {}): LinearIssue => ({
  id: "i1",
  identifier: "ENG-1",
  title: "Fix login",
  description: "The redirect loops.",
  updatedAt: "2026-10-09T12:00:00.000Z",
  assigneeId: "me",
  stateType: "unstarted",
  labels: [],
  team: { id: "t", key: "ENG", name: "Engineering" },
  project: null,
  comments: [],
  ...fields,
});

const opts = {
  template: "{title}\n\n{description}\n\n{comments}",
  comments: "all",
  viewerId: "me",
} as const;

describe("renderTask", () => {
  it("renders title, description and comments oldest first as author: body", () => {
    const text = renderTask(
      issue({ comments: [comment("first"), comment("second", { id: "bo", name: "Bo" })] }),
      opts,
    );
    expect(text).toBe("Fix login\n\nThe redirect loops.\n\nMia: first\nBo: second");
  });

  it("uses an empty string for a missing description and unknown for a missing author", () => {
    const c = { ...comment("hi"), user: null };
    expect(renderTask(issue({ description: null, comments: [c] }), opts)).toBe(
      "Fix login\n\n\n\nunknown: hi",
    );
  });

  it("leaves out daemon comments and command comments, keeps lookalikes", () => {
    const comments = [
      comment(`${MARKER}\nQueued for autoforge (position 1).`),
      comment("/publish"),
      comment("  /retry use tabs"),
      comment("/discard"),
      comment("/publishing is next week"),
    ];
    expect(renderTask(issue({ comments }), { ...opts, template: "{comments}" })).toBe(
      "Mia: /publishing is next week",
    );
  });

  it('keeps only the viewer\'s comments with comments: "mine"', () => {
    const comments = [comment("mine"), comment("theirs", { id: "bo", name: "Bo" })];
    expect(
      renderTask(issue({ comments }), { ...opts, template: "{comments}", comments: "mine" }),
    ).toBe("Mia: mine");
  });

  it("keeps $ sequences and placeholders inside issue text literal", () => {
    const text = renderTask(issue({ title: "Cost $& and $1 {description}", description: "$$" }), {
      ...opts,
      template: "{title}|{description}",
    });
    expect(text).toBe("Cost $& and $1 {description}|$$");
  });

  it("appends the reviewer's feedback for a retry", () => {
    expect(
      renderTask(issue(), { ...opts, template: "{title}", feedback: "Use tabs.\nAnd tests." }),
    ).toBe(
      "Fix login\n\nFeedback from the reviewer on the previous attempt:\nUse tabs.\nAnd tests.",
    );
  });
});

describe("parseCommand", () => {
  it.each([
    ["/publish", { kind: "publish", force: false }],
    ["  /publish force  ", { kind: "publish", force: true }],
    ["/publish\nforce", { kind: "publish", force: true }],
    ["/publish please", { kind: "publish", force: false }],
    ["/discard", { kind: "discard" }],
    ["/retry", { kind: "retry" }],
    ["/retry use tabs\nand add a test", { kind: "retry", feedback: "use tabs\nand add a test" }],
    ["/publishing", null],
    ["please /publish", null],
    [`${MARKER}\n/publish`, null],
    ["", null],
  ])("%j", (body, expected) => {
    expect(parseCommand(body)).toEqual(expected);
  });
});

import type { LinearIssue } from "./linear.js";

/** First line of every comment the daemon posts. */
export const MARKER = "<!-- autoforge -->";

export type Command =
  { kind: "publish"; force: boolean } | { kind: "discard" } | { kind: "retry"; feedback?: string };

export function parseCommand(body: string): Command | null {
  const m = /^\/(publish|discard|retry)(?:\s+([\s\S]*))?$/.exec(body.trim());
  if (!m) return null;
  const arg = m[2]?.trim() ?? "";
  if (m[1] === "publish") return { kind: "publish", force: arg === "force" };
  if (m[1] === "discard") return { kind: "discard" };
  return arg ? { kind: "retry", feedback: arg } : { kind: "retry" };
}

export type RenderOptions = {
  template: string;
  comments: "all" | "mine";
  viewerId: string;
  feedback?: string;
};

export function renderTask(issue: LinearIssue, o: RenderOptions): string {
  const comments = issue.comments
    .filter(
      (c) =>
        !c.body.trimStart().startsWith(MARKER) &&
        !parseCommand(c.body) &&
        (o.comments === "all" || c.user?.id === o.viewerId),
    )
    .map((c) => `${c.user?.name ?? "unknown"}: ${c.body}`)
    .join("\n");
  const values: Record<string, string> = {
    title: issue.title,
    description: issue.description ?? "",
    comments,
  };
  // One pass with a replacer function: `$` sequences and placeholders inside issue text stay literal.
  const text = o.template.replace(
    /\{(title|description|comments)\}/g,
    (_, key: string) => values[key] ?? "",
  );
  return o.feedback
    ? `${text}\n\nFeedback from the reviewer on the previous attempt:\n${o.feedback}`
    : text;
}

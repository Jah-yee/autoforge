// Usage:
//   docker build -t autoforge-claude examples
//   REPO=owner/name GITHUB_TOKEN=... ANTHROPIC_API_KEY=... node examples/basic.ts "Fix the typo in README"
// Node 23.6+ runs .ts directly; on Node 22 add --experimental-strip-types.
import { run } from "autoforge";
import { DockerSandbox } from "autoforge/docker";
import { publishToGitHub } from "autoforge/github";

const repo = process.env.REPO;
const token = process.env.GITHUB_TOKEN;
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!repo || !token || !apiKey) throw new Error("set REPO, GITHUB_TOKEN and ANTHROPIC_API_KEY");

const result = await run({
  repo: { url: `https://github.com/${repo}.git`, ref: "main", token },
  task: process.argv[2] ?? "Fix any typos in README.md",
  // Skipping Claude Code's permission prompts is acceptable here because it runs in the sandbox.
  agent: {
    command: ["claude", "-p", "{task}", "--dangerously-skip-permissions"],
    env: { ANTHROPIC_API_KEY: apiKey },
  },
  sandbox: new DockerSandbox({ image: "autoforge-claude" }),
  onEvent: (e) => console.log(e.type === "log" ? e.line : `== ${e.phase}`),
});

console.log(`status: ${result.status}, files: ${result.filesChanged.join(", ") || "none"}`);
if (result.status === "changed") {
  const pr = await publishToGitHub(result, { repo, token });
  console.log(`draft PR: ${pr.prUrl}`);
}

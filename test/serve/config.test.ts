import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_TEMPLATE,
  loadConfig,
  parseConfig,
  parseRepoSpec,
  readEnvFile,
  readSecrets,
} from "../../src/serve/config.js";

const minimal = { agent: { image: "autoforge-claude", command: ["claude", "-p", "{task}"] } };

describe("parseConfig", () => {
  it("fills in the defaults", () => {
    expect(parseConfig(minimal)).toEqual({
      pollSeconds: 30,
      maxConcurrent: 1,
      dailyRunLimit: 20,
      approvalExpiryDays: 14,
      pickup: "labelled",
      label: "autoforge",
      comments: "all",
      defaultRepo: undefined,
      rules: [],
      agent: {
        image: "autoforge-claude",
        command: ["claude", "-p", "{task}"],
        envFrom: [],
        timeoutMinutes: 30,
      },
      template: DEFAULT_TEMPLATE,
    });
  });

  it("accepts the full example from the spec", () => {
    const config = parseConfig({
      pollSeconds: 30,
      maxConcurrent: 1,
      dailyRunLimit: 20,
      approvalExpiryDays: 14,
      pickup: "labelled",
      label: "autoforge",
      comments: "all",
      defaultRepo: "me/app@main",
      rules: [
        { linearProject: "Docs", repo: "me/docs@main" },
        { linearTeam: "ENG", repo: "me/app@develop", agent: { image: "my-agent" } },
      ],
      agent: {
        image: "autoforge-claude",
        command: ["claude", "-p", "{task}", "--dangerously-skip-permissions"],
        envFrom: ["ANTHROPIC_API_KEY"],
        timeoutMinutes: 30,
      },
      template: "{title}\n\n{description}",
    });
    expect(config.rules[1]).toEqual({
      linearTeam: "ENG",
      repo: "me/app@develop",
      agent: { image: "my-agent" },
    });
    expect(config.agent.envFrom).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it.each([
    ["not an object", [], "config.json must contain a JSON object"],
    ["unknown key", { ...minimal, pollSecond: 30 }, "config.pollSecond"],
    ["poll too fast", { ...minimal, pollSeconds: 5 }, "config.pollSeconds"],
    ["fractional limit", { ...minimal, dailyRunLimit: 1.5 }, "config.dailyRunLimit"],
    ["zero concurrency", { ...minimal, maxConcurrent: 0 }, "config.maxConcurrent"],
    ["bad pickup", { ...minimal, pickup: "everything" }, "config.pickup"],
    ["bad comments", { ...minimal, comments: "none" }, "config.comments"],
    ["empty label", { ...minimal, label: "" }, "config.label"],
    ["bad default repo", { ...minimal, defaultRepo: "not a repo" }, "config.defaultRepo"],
    ["default repo branch flag", { ...minimal, defaultRepo: "me/app@-x" }, "config.defaultRepo"],
    ["no agent", {}, "config.agent"],
    ["agent without image", { agent: { command: ["x"] } }, "config.agent.image"],
    ["empty command", { agent: { image: "i", command: [] } }, "config.agent.command"],
    [
      "bad env name",
      { agent: { image: "i", command: ["x"], envFrom: ["NOT-A-NAME"] } },
      "config.agent.envFrom",
    ],
    [
      "zero timeout",
      { agent: { ...minimal.agent, timeoutMinutes: 0 } },
      "config.agent.timeoutMinutes",
    ],
    ["rules not a list", { ...minimal, rules: {} }, "config.rules"],
    [
      "rule with both matchers",
      { ...minimal, rules: [{ linearProject: "A", linearTeam: "B", repo: "me/a" }] },
      "config.rules[0]",
    ],
    ["rule with no matcher", { ...minimal, rules: [{ repo: "me/a" }] }, "config.rules[0]"],
    [
      "rule with bad repo",
      { ...minimal, rules: [{ linearTeam: "ENG", repo: "nope" }] },
      "config.rules[0].repo",
    ],
    [
      "rule agent with unknown key",
      { ...minimal, rules: [{ linearTeam: "ENG", repo: "me/a", agent: { img: "x" } }] },
      "config.rules[0].agent.img",
    ],
    ["empty template", { ...minimal, template: "" }, "config.template"],
  ])("rejects %s and names the field", (_name, raw, field) => {
    expect(() => parseConfig(raw)).toThrow(ConfigError);
    expect(() => parseConfig(raw)).toThrow(field);
  });
});

describe("parseRepoSpec", () => {
  it.each([
    ["me/app", { repo: "me/app", ref: "main" }],
    ["me/app@develop", { repo: "me/app", ref: "develop" }],
    ["my-org/app.js@release/1.2", { repo: "my-org/app.js", ref: "release/1.2" }],
    ["me/app@", null],
    ["me/app@-rf", null],
    ["me/app@has space", null],
    ["me", null],
    ["me/app/extra", null],
  ])("%s", (spec, expected) => {
    expect(parseRepoSpec(spec)).toEqual(expected);
  });
});

describe("readSecrets", () => {
  const config = parseConfig({
    agent: { image: "i", command: ["x"], envFrom: ["ANTHROPIC_API_KEY"] },
    rules: [{ linearTeam: "ENG", repo: "me/a", agent: { envFrom: ["OPENAI_API_KEY"] } }],
  });
  const env = {
    LINEAR_API_KEY: "lin",
    GITHUB_TOKEN: "gh",
    ANTHROPIC_API_KEY: "ant",
    OPENAI_API_KEY: "oai",
  };

  it("reads the tokens and every agent env name, including the rules'", () => {
    expect(readSecrets(config, env)).toEqual({
      linearApiKey: "lin",
      githubToken: "gh",
      cloneToken: undefined,
      agentEnv: { ANTHROPIC_API_KEY: "ant", OPENAI_API_KEY: "oai" },
    });
    expect(readSecrets(config, { ...env, CLONE_TOKEN: "clone" }).cloneToken).toBe("clone");
  });

  it.each(["LINEAR_API_KEY", "GITHUB_TOKEN", "OPENAI_API_KEY"])("requires %s", (name) => {
    expect(() => readSecrets(config, { ...env, [name]: undefined })).toThrow(
      new ConfigError(`${name} is not set. Put it in ~/.autoforge/env or the environment.`),
    );
  });
});

describe("files", () => {
  const dir = () => mkdtemp(join(tmpdir(), "autoforge-config-"));

  it("loads config.json from the directory", async () => {
    const d = await dir();
    await writeFile(join(d, "config.json"), JSON.stringify(minimal));
    expect((await loadConfig(d)).agent.image).toBe("autoforge-claude");
  });

  it("explains a missing or broken config.json", async () => {
    const d = await dir();
    await expect(loadConfig(d)).rejects.toThrow(`${join(d, "config.json")} not found`);
    await writeFile(join(d, "config.json"), "{ nope");
    await expect(loadConfig(d)).rejects.toThrow("is not valid JSON");
  });

  it("returns an empty env when there is no env file", async () => {
    expect(await readEnvFile(await dir())).toEqual({});
  });

  it("reads an env file with mode 600", async () => {
    const d = await dir();
    await writeFile(join(d, "env"), 'LINEAR_API_KEY=lin\n# comment\nGITHUB_TOKEN="gh"\n');
    await chmod(join(d, "env"), 0o600);
    expect(await readEnvFile(d)).toMatchObject({ LINEAR_API_KEY: "lin", GITHUB_TOKEN: "gh" });
  });

  it.each([0o644, 0o640, 0o602])("refuses an env file with mode %o", async (mode) => {
    const d = await dir();
    await writeFile(join(d, "env"), "LINEAR_API_KEY=lin\n");
    await chmod(join(d, "env"), mode);
    await expect(readEnvFile(d)).rejects.toThrow(`Run: chmod 600 ${join(d, "env")}`);
  });
});

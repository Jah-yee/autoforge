import { describe, expect, it } from "vitest";
import { proc } from "../src/proc.js";

describe("proc", () => {
  it("passes arguments without a shell", async () => {
    const r = await proc("printf", ["%s", "a; echo b"]);
    expect(r).toMatchObject({ exitCode: 0, stdout: "a; echo b" });
  });

  it("pipes input to stdin", async () => {
    expect((await proc("cat", [], { input: "hi" })).stdout).toBe("hi");
  });

  it("streams to callbacks instead of collecting", async () => {
    const chunks: string[] = [];
    const r = await proc("printf", ["x"], { onStdout: (c) => chunks.push(c) });
    expect(chunks.join("")).toBe("x");
    expect(r.stdout).toBe("");
  });

  it("returns 127 for a missing command", async () => {
    expect((await proc("autoforge-no-such-command", [])).exitCode).toBe(127);
  });

  it("kills the whole process group on abort", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const t = Date.now();
    const r = await proc("sh", ["-c", "sleep 30"], { signal: ac.signal, killGroup: true });
    expect(r.exitCode).toBeNull();
    expect(Date.now() - t).toBeLessThan(5_000);
  });
});

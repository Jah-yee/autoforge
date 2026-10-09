import { describe, expect, it } from "vitest";
import { LineSplitter, TailBuffer } from "../src/logs.js";
import { makeRedactor } from "../src/redact.js";

describe("LineSplitter", () => {
  it("joins chunks into lines, strips \\r, and flushes the remainder", () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l));
    s.push("one\r\ntw");
    s.push("o\nthree");
    expect(lines).toEqual(["one", "two"]);
    s.flush();
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it("masks a secret split across two chunks", () => {
    const redact = makeRedactor(["sk-abc123"]);
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(redact(l)));
    s.push("key=sk-ab");
    s.push("c123\n");
    expect(lines).toEqual(["key=***"]);
  });
});

describe("TailBuffer", () => {
  it("keeps everything under the limit with no marker", () => {
    const b = new TailBuffer(100);
    b.push("a");
    b.push("b");
    expect(b.toString()).toBe("a\nb");
  });

  it("drops the oldest lines past the limit and marks the output", () => {
    const b = new TailBuffer(10);
    for (const l of ["11111", "22222", "33333"]) b.push(l);
    expect(b.toString()).toBe("[truncated]\n33333");
  });
});

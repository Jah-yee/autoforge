import { describe, expect, it } from "vitest";
import { makeRedactor } from "../src/redact.js";

describe("makeRedactor", () => {
  it("masks every secret of 4 or more characters", () => {
    expect(makeRedactor(["sk-abc123", "tok"])("sk-abc123 and tok")).toBe("*** and tok");
  });

  it("masks the longest secret first so overlaps are fully hidden", () => {
    expect(makeRedactor(["abcd", "abcdefgh"])("x abcdefgh y")).toBe("x *** y");
  });

  it("ignores undefined and empty values", () => {
    expect(makeRedactor([undefined, ""])("nothing to hide")).toBe("nothing to hide");
  });
});

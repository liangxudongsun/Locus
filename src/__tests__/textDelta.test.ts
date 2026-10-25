import { describe, expect, it } from "vitest";
import { applyTextDelta, singleSpanDelta, textHash } from "../document/textDelta";

describe("shared text deltas", () => {
  it("hashes like the Rust stores", () => {
    // Same vectors as src-tauri/src/text_delta.rs.
    expect(textHash("")).toBe("0-bdcb81aee8d83");
    expect(textHash("a")).toBe("1-1c2ba782c97901");
    expect(textHash("hello world")).toBe("b-b9417d15d1014");
    expect(textHash("中文😀\r\nline")).toBe("a-1428410d672b1c");
    expect(textHash("x".repeat(1000))).toBe("3e8-1a7942aee5273b");
  });
  it("produces one span that never splits a surrogate pair", () => {
    for (const [base, next] of [["a😀b", "a😁b"], ["abcabc", "abc"], ["aaa", "aaaa"], ["", "新"], ["中文", ""]] as const) {
      const delta = singleSpanDelta(base, next)!;
      expect(applyTextDelta(base, delta)).toBe(next);
    }
    expect(singleSpanDelta("a😀b", "a😁b")).toEqual({ from: 1, to: 3, insert: "😁" });
    expect(singleSpanDelta("same", "same")).toBeNull();
  });
  it("finds the minimal span for random edits", () => {
    const alphabet = ["a", "b", "\n", "中", "😀", "😁"];
    let seed = 7;
    const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const word = (length: number) => Array.from({ length }, () => alphabet[random(alphabet.length)]).join("");
    for (let round = 0; round < 500; round += 1) {
      const base = word(random(40));
      const from = random(base.length + 1);
      const to = from + random(base.length - from + 1);
      const next = base.slice(0, from) + word(random(6)) + base.slice(to);
      const delta = singleSpanDelta(base, next);
      if (base === next) { expect(delta).toBeNull(); continue; }
      expect(applyTextDelta(base, delta!)).toBe(next);
      // Minimal up to one code unit per side for surrogate-pair boundaries.
      expect(delta!.to - delta!.from).toBeLessThanOrEqual(to - from + 2);
      for (const offset of [delta!.from, delta!.to]) {
        const code = base.charCodeAt(offset);
        expect(offset > 0 && offset < base.length && code >= 0xdc00 && code <= 0xdfff).toBe(false);
      }
    }
  });
});

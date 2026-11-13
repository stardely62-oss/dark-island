import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EN } from "../src/i18n.en";

// Every Russian text passed to t() has an English translation.
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) && !n.startsWith("i18n") ? [p] : [];
  });
}

describe("English dictionary", () => {
  it("covers every t() text", () => {
    const missing: string[] = [];
    for (const f of files("src")) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bt\(("(?:[^"\\]|\\.)*")/g)) {
        const key = JSON.parse(m[1]) as string;
        if (/[А-Яа-яЁё]/.test(key) && !(key in EN)) missing.push(`${f}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

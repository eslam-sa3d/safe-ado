import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

/** The stylesheet is only parsed by webpack's css-loader, so check its structure in the suite too. */
describe("styles.css", () => {
  const css = readFileSync(resolve(__dirname, "../../src/hub/styles.css"), "utf8");

  it("has balanced braces", () => {
    let depth = 0;
    for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it("contains no merge-conflict markers", () => {
    expect(css).not.toMatch(/^(<{7}|={7}|>{7})/m);
  });
});

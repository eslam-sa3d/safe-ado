import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { changelogSection, checkRelease } from "../../scripts/check-release.mjs";

const CHANGELOG = `# Changelog

## [Unreleased]

## [1.3.0] - 2026-09-30
### Added
- PI Planning view

## [1.2.0] - 2026-09-29
### Changed
- New design

[1.3.0]: https://example.com/compare/v1.2.0...v1.3.0
`;

describe("changelogSection", () => {
  it("returns the body of a version's section", () => {
    expect(changelogSection(CHANGELOG, "1.3.0")).toBe("### Added\n- PI Planning view");
    expect(changelogSection(CHANGELOG, "1.2.0")).toBe("### Changed\n- New design");
    expect(changelogSection(CHANGELOG, "1.1.0")).toBeUndefined();
    expect(changelogSection(CHANGELOG, "Unreleased")).toBe("");
  });

  it("does not confuse 1.3.0 with 1.3.01 or 1x3y0", () => {
    expect(changelogSection("## [1.3.01]\n- x\n", "1.3.0")).toBeUndefined();
    expect(changelogSection("## 1x3y0\n- x\n", "1.3.0")).toBeUndefined();
  });
});

describe("checkRelease", () => {
  const ok = { packageVersion: "1.3.0", manifestVersion: "1.3.0", changelog: CHANGELOG };

  it("passes when versions, tag and changelog agree", () => {
    expect(checkRelease(ok)).toEqual([]);
    expect(checkRelease({ ...ok, tag: "v1.3.0" })).toEqual([]);
    expect(checkRelease({ ...ok, tag: "refs/tags/v1.3.0" })).toEqual([]);
  });

  it("fails when package.json and the manifest differ", () => {
    expect(checkRelease({ ...ok, manifestVersion: "1.2.0", versionsOnly: true })).toEqual([
      "package.json version 1.3.0 differs from vss-extension.json version 1.2.0",
    ]);
    expect(checkRelease({ ...ok, versionsOnly: true, changelog: undefined })).toEqual([]);
  });

  it("fails on a tag that does not match", () => {
    expect(checkRelease({ ...ok, tag: "v1.3.1" })).toEqual([
      "tag v1.3.1 does not match package.json version 1.3.0",
      "tag v1.3.1 does not match vss-extension.json version 1.3.0",
    ]);
  });

  it("fails without a changelog entry", () => {
    expect(checkRelease({ ...ok, changelog: undefined })).toEqual(["CHANGELOG.md not found"]);
    expect(checkRelease({ ...ok, packageVersion: "1.4.0", manifestVersion: "1.4.0" })).toEqual([
      'CHANGELOG.md has no "## [1.4.0]" heading',
    ]);
    expect(checkRelease({ ...ok, changelog: "## [1.3.0]\n\n## [1.2.0]\n- x" })).toEqual(["CHANGELOG.md section for 1.3.0 is empty"]);
    expect(checkRelease({ changelog: CHANGELOG })).toEqual(["package.json has no version", "vss-extension.json has no version"]);
  });
});

describe("repository release state", () => {
  const root = resolve(__dirname, "../..");
  const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;

  it("package.json, vss-extension.json and CHANGELOG.md agree (npm run release:check)", () => {
    const out = execFileSync(process.execPath, [resolve(root, "scripts/check-release.mjs"), `v${version}`], {
      cwd: root,
      env: { ...process.env, GITHUB_REF: "", GITHUB_REF_TYPE: "", GITHUB_REF_NAME: "" },
      encoding: "utf8",
    });
    expect(out).toContain(`Release check OK: ${version}`);
  });

  it("exits non-zero for a wrong tag", () => {
    expect(() =>
      execFileSync(process.execPath, [resolve(root, "scripts/check-release.mjs"), "v0.0.0-nope"], { cwd: root, stdio: "pipe" })
    ).toThrow();
  });
});

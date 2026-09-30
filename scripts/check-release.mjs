#!/usr/bin/env node
/**
 * Release consistency check.
 *
 *   node scripts/check-release.mjs                 # versions match + CHANGELOG has the version
 *   node scripts/check-release.mjs v1.3.0          # ...and the tag matches (also reads GITHUB_REF_NAME)
 *   node scripts/check-release.mjs --versions-only # only package.json == vss-extension.json (pre-package guard)
 *   node scripts/check-release.mjs --notes out.md  # also write the version's CHANGELOG section to out.md
 *
 * Exits 1 with a list of problems when anything is inconsistent.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The CHANGELOG section for a version (without its heading), or undefined when there is none. */
export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = new RegExp(`^## \\[?${escape(version)}\\]?(\\s|$)`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return undefined;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  // Drop link reference definitions ([1.2.0]: https://...) that sit at the end of the file.
  const body = lines.slice(start + 1, end).filter((l) => !/^\[[^\]]+\]:\s*\S+/.test(l));
  return body.join("\n").trim();
}

/** Problems with a release; an empty list means it is consistent. */
export function checkRelease({ packageVersion, manifestVersion, tag, changelog, versionsOnly = false }) {
  const errors = [];
  if (!packageVersion) errors.push("package.json has no version");
  if (!manifestVersion) errors.push("vss-extension.json has no version");
  if (packageVersion && manifestVersion && packageVersion !== manifestVersion) {
    errors.push(`package.json version ${packageVersion} differs from vss-extension.json version ${manifestVersion}`);
  }
  if (versionsOnly) return errors;
  if (tag) {
    const tagVersion = tag.replace(/^refs\/tags\//, "").replace(/^v/, "");
    if (tagVersion !== packageVersion) errors.push(`tag ${tag} does not match package.json version ${packageVersion}`);
    if (tagVersion !== manifestVersion) errors.push(`tag ${tag} does not match vss-extension.json version ${manifestVersion}`);
  }
  if (changelog === undefined) errors.push("CHANGELOG.md not found");
  else if (packageVersion) {
    const section = changelogSection(changelog, packageVersion);
    if (section === undefined) errors.push(`CHANGELOG.md has no "## [${packageVersion}]" heading`);
    else if (!section) errors.push(`CHANGELOG.md section for ${packageVersion} is empty`);
  }
  return errors;
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (f) => {
    try {
      return readFileSync(resolve(root, f), "utf8");
    } catch {
      return undefined;
    }
  };
  const versionsOnly = argv.includes("--versions-only");
  const notesAt = argv.indexOf("--notes");
  const notesFile = notesAt >= 0 ? argv[notesAt + 1] : undefined;
  const positional = argv.filter((a, i) => !a.startsWith("--") && !(notesAt >= 0 && i === notesAt + 1));
  const envTag = process.env.GITHUB_REF_TYPE === "tag" || /^refs\/tags\//.test(process.env.GITHUB_REF ?? "") ? process.env.GITHUB_REF_NAME : undefined;
  const tag = positional[0] ?? envTag;

  const packageVersion = JSON.parse(read("package.json") ?? "{}").version;
  const manifestVersion = JSON.parse(read("vss-extension.json") ?? "{}").version;
  const changelog = read("CHANGELOG.md");
  const errors = checkRelease({ packageVersion, manifestVersion, tag, changelog, versionsOnly });
  if (errors.length) {
    console.error(`Release check failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    return 1;
  }
  if (notesFile) writeFileSync(resolve(process.cwd(), notesFile), `${changelogSection(changelog, packageVersion)}\n`);
  console.log(`Release check OK: ${packageVersion}${tag ? ` (tag ${tag})` : ""}${versionsOnly ? " (versions only)" : ""}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

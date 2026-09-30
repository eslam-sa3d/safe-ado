export function changelogSection(changelog: string, version: string): string | undefined;
export function checkRelease(opts: {
  packageVersion?: string;
  manifestVersion?: string;
  tag?: string;
  changelog?: string;
  versionsOnly?: boolean;
}): string[];

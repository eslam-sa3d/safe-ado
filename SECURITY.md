# Security policy

## Reporting a vulnerability

**Please do not report security vulnerabilities in public GitHub issues, discussions or Marketplace
Q & A.**

Report privately with GitHub's **private vulnerability reporting**: open the repository's
[Security tab](https://github.com/eslam-sa3d/safe-ado/security) and choose
*Report a vulnerability*. If that isn't available to you, open a public issue that only asks for a
private contact. Put no details in it.

Please include:

- The affected version of ScaleLane, and whether you use Azure DevOps Services or Server (with its version).
- A description of the issue and its impact. For example: cross-site scripting through a work item
  field, data exposure across projects, or privilege escalation through extension data.
- Steps to reproduce or a proof of concept. Use test data, not real customer data.
- Any suggested fix.

## What to expect

| Step | Target |
|---|---|
| Acknowledgement | within 3 business days |
| Initial assessment and severity | within 10 business days |
| Fix released for confirmed high/critical issues | as fast as practical, aiming for 30 days |

We will keep you informed, credit you in the release notes if you wish, and ask you not to disclose
the issue publicly until a fix is released or 90 days have passed, whichever comes first.

## Scope

In scope: the code in this repository and the VSIX published on the Visual Studio Marketplace under
the `SAFeADO` publisher.

Out of scope: vulnerabilities in Azure DevOps itself (report them to the
[Microsoft Security Response Center](https://msrc.microsoft.com/)), and findings that need an
already-compromised Azure DevOps account or browser.

## Known design limitations

Extension data (objectives, risks, capacity, PI assignments and similar) is stored in the Azure
DevOps Extension Data Service. Any project member can write it through the REST API. The
extension's permission checks are UI rules, not server-side enforcement. See *Limitations* in
[docs/AGILE_HIVE_PARITY.md](docs/AGILE_HIVE_PARITY.md). Reports that only restate this limitation
are not treated as vulnerabilities. Reports that show a new impact are welcome.

## Supported versions

Security fixes are released for the latest version only.

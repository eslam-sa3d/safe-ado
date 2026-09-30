# Privacy and data handling

ScaleLane runs entirely inside Azure DevOps, as a web extension in the browser of the person using
it. It has no backend service. Its publisher does not receive your planning data.

## Where your data lives

| Data | Where it is stored |
|---|---|
| Epics, capabilities, features, stories, their dates, iterations, area paths, parent and dependency links | Ordinary Azure DevOps **work items, iterations and links** in your project |
| SAFe configuration: hierarchy, type mapping, PI root, settings, the telemetry opt-in | Azure DevOps **Extension Data Service**, project-scoped value |
| PI objectives, ROAM risks, milestones, capacity, PI assignments and owning/involved units (`wimeta`), quick filters, confidence votes, plan reviews, PI snapshots | Azure DevOps **Extension Data Service**, project-scoped document collections |
| Per-user preferences (starred units, tours seen, report options) | Azure DevOps **Extension Data Service**, user-scoped values |
| Last selected unit, view and PI | The browser's `localStorage` on that machine |

The Extension Data Service is part of your Azure DevOps organization or your Azure DevOps Server
collection. On Azure DevOps Server 2022.1 the data never leaves your servers. Backup, retention,
residency and deletion follow your Azure DevOps setup. Uninstalling the extension doesn't delete
work items. Extension data is removed as Azure DevOps removes an uninstalled extension's data.

The extension asks for these scopes: `vso.work_write` (read and write work items, iterations and
areas) and `vso.project` (read projects and teams).

## Network calls

- **Azure DevOps REST APIs only**, on the host you are signed in to. The calls use the Azure DevOps
  SDK's access token and are pinned to `api-version=7.0`.
- **No other outbound calls**, with one opt-in exception: usage telemetry (next section).
- The Help menu has links to the GitHub repository. They only open when you click them.
- The fonts and icons are bundled in the extension. No CDNs, analytics scripts or trackers are loaded.

## Usage telemetry (opt-in, off by default)

ScaleLane can send anonymous usage events to help its maintainers see which views are used. It sends
nothing unless **both** conditions are met:

1. **The build has a telemetry endpoint.** It is set with the `SAFE_ADO_TELEMETRY_URL` environment
   variable when the extension is built, and must be an `https://` URL. The default build leaves it
   empty, so it has no endpoint and cannot send anything, whatever the setting. If a
   Marketplace build ever ships with an endpoint, the release notes will say so and name it.
2. **A project administrator opted in.** The setting is *Setup → Usage data → Share anonymous usage
   data*. It is stored as `telemetryOptIn: true` in that project's SAFe configuration and is off
   by default.

Setup tells you when the build has no endpoint.

### Exactly what is sent

Each event is one small JSON object, sent as an HTTP `POST` with `navigator.sendBeacon`. When a
beacon can't be sent, a `fetch` with `keepalive`, `credentials: "omit"` and `mode: "no-cors"` is
used instead. It is fire-and-forget: a failed send is ignored and never affects the extension.

```json
{ "schema": 1, "event": "view_opened.reports", "version": "1.3.0", "collection": "3f1c…(32 hex chars)" }
```

| Field | Content |
|---|---|
| `schema` | Payload format version, currently `1` |
| `event` | An event name from a fixed list, optionally followed by a view id (lowercase letters, digits, `_` and `-` only, at most 32 characters). Anything else is dropped before sending. |
| `version` | The extension version, e.g. `1.3.0` |
| `collection` | The first 32 hex characters of `SHA-256("safe-ado-telemetry-v1:" + <organization / collection id>)`. This is a pseudonym: it lets installs be counted, but it doesn't contain the id. |

**Event names:** `view_opened` (with the view id, e.g. `view_opened.teamboard`), `pi_created`,
`board_replanned`, `objective_created`, `risk_created`, `config_saved`. In version 1.3.0 only
`view_opened` is emitted, when a user opens a hub view. The other names are reserved, and their
use will be listed in the CHANGELOG when they are wired.

**Never sent:** work item ids, titles, descriptions, field values, area or iteration paths, unit,
team, PI, objective or risk names, user names, e-mail addresses, user or project ids, the
organization or collection name or URL, IP-derived data added by the extension, or free text of any
kind. No cookies or credentials are attached. The receiving server still sees the connection's IP
address and user agent, as with any HTTP request. The endpoint operator's policy applies to those
and should say how long they are kept.

To stop telemetry, clear the checkbox in Setup and save. The next event is not sent. To verify what
is sent, see [`src/api/telemetry.ts`](../src/api/telemetry.ts) and its tests in
[`test/api/telemetry.test.tsx`](../test/api/telemetry.test.tsx).

## Security notes

- Extension data isn't protected by Azure DevOps area security. Any project member can read and
  write it through the REST API. See *Limitations* in [AGILE_HIVE_PARITY.md](AGILE_HIVE_PARITY.md).
- To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Contact

Questions about this statement: open an issue at https://github.com/eslam-sa3d/safe-ado/issues
(see [SUPPORT.md](../SUPPORT.md)).

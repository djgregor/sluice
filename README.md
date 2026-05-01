# Sluice

**Bidirectional Google Sheets ↔ Jira sync.**

Sluice lets you manage Jira issues from a spreadsheet — pull issues in,
edit them in bulk, and keep everything in sync with last-write-wins
conflict resolution.

## Why

Jira's UI is optimized for individual issue views and board-level
planning.  When you need to triage 50 bugs, rebalance assignments across
a team, or bulk-create a backlog from a planning spreadsheet, the
experience is painful.  Spreadsheets are the natural tool for tabular
bulk operations — sort, filter, multi-select, copy/paste, formulas.

Sluice bridges the gap: your spreadsheet becomes a live, two-way view of
Jira.  Edit in the sheet, sync to Jira.  Edit in Jira, sync to the
sheet.  No manual CSV exports, no copy-pasting, no stale data.

## Features

- **Bidirectional sync** — Pull from Jira, or sync both directions with
  scope-safe conflict resolution
- **Last-write-wins conflict resolution** — uses timestamps to determine
  which side changed more recently
- **Multi-hop status transitions** — change a status from "Draft" to
  "Done" in the sheet and Sluice walks through all required intermediate
  Jira workflow states automatically
- **Issue creation** — add a row with a Summary (no Key), push, and a
  new Jira issue is created with the Key written back to the sheet
- **Relationship management** — parent/child links, DependsOn, and
  Blocking issue links managed directly from the sheet
- **Configurable custom fields** — LoE Days, Story Points, Sprint,
  WorkArea, Team, and Bug-specific text fields are configurable per
  installation.  Standard fields (Environment, Fix Versions, Resolution,
  Created, Updated) work with no configuration.
- **Per-user credentials** — each collaborator stores their own Jira API
  token; credentials are never shared or written to the spreadsheet
- **Portable team deployment** — shared defaults (base URL, project key,
  custom field IDs) are baked in at install time so team members only
  enter their email and API token
- **Clickable issue links** — Key column values are hyperlinks to the
  Jira issue

## Quick Start

```bash
# One-time setup
npm install -g @google/clasp
clasp login

# If your system Node.js is restricted, install via nvm first:
# curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# nvm install --lts
# npm install -g @google/clasp && clasp login

# Configure team defaults (optional)
cd sluice
cp defaults.conf.example defaults.conf
# Edit defaults.conf with your org's Jira base URL, project key, etc.

# Install into a Google Sheet
./install.sh
```

After installation, reload your Google Sheet.  The **Sluice** menu
appears in the menu bar.  Open **Sluice → Settings** to enter your Jira
email and API token, then **Test Connection** to verify.

See [SETUP.md](SETUP.md) for detailed installation, configuration,
column reference, and usage instructions.

## Architecture

Sluice is a Google Apps Script project bound to a Google Sheet.  It uses
the Jira Cloud REST API v3 with Basic authentication (email + API
token).

```
┌──────────────┐         ┌──────────────────┐         ┌────────────┐
│ Google Sheet │ ◄─────► │ Apps Script (GAS) │ ◄─────► │ Jira Cloud │
│  (your data) │  Sheet  │   (this code)     │  REST   │    API v3  │
└──────────────┘   API   └──────────────────┘  HTTPS   └────────────┘
```

### File Overview

| File              | Purpose                                           |
|-------------------|---------------------------------------------------|
| `Code.gs`         | Menu setup, entry points, connection test          |
| `Config.gs`       | Per-user settings via `UserProperties`             |
| `JiraApi.gs`      | REST client, pagination, input validation          |
| `SheetMeta.gs`    | Column definitions, sheet-name parsing, headers    |
| `Pull.gs`         | Jira → Sheet sync                                 |
| `Push.gs`         | Sheet → Jira helpers (create, update, transitions, links) |
| `Sync.gs`         | Bidirectional sync with conflict resolution        |
| `Workflows.gs`    | Workflow lookup helpers, transition field auto-fill |
| `Sidebar.html`    | Settings dialog UI                                 |
| `install.sh`      | Deployment script (clasp-based)                    |
| `defaults.conf`   | Team-shared configuration (gitignored)             |
| `Defaults.gs`     | Generated at install time from `defaults.conf`     |

### Sync Model

Sluice uses last-write-wins conflict resolution:

1. Each synced row carries a **Last Synced** timestamp
2. Each Jira issue carries an **updated** timestamp
3. On sync:
   - If `Jira.updated > Last Synced` → Jira was edited more recently → **pull**
   - If `Jira.updated ≤ Last Synced` and the row differs → local edit → **push**
   - If no differences → **skip**

This means that if both sides are edited between syncs, Jira wins.  To
ensure sheet edits take priority, sync frequently.

## Multi-Hop Status Transitions

Jira workflows don't allow arbitrary status jumps — you must follow
defined transitions.  Sluice handles this automatically.

When you change a status in the sheet (e.g., "Draft" → "Done"), Sluice:

1. Looks up the issue type's workflow sequence (declared via `SLUICE_WORKFLOW_*` in `defaults.conf`)
2. Identifies the next intermediate status in the sequence
3. Checks available Jira transitions for a match
4. Executes the transition, auto-filling any required fields
5. Repeats until the target status is reached (up to 8 hops)

### Transition Priority

At each hop, Sluice chooses the transition to execute in this order:

1. **Direct** — a transition straight to the target status
2. **Sequence** — the next step in the defined workflow sequence
3. **Fallback** — the first available unvisited, non-terminal transition

### Excluded Intermediates

Terminal or side statuses (e.g. Won't Fix, Blocked, Cancelled) are
never used as intermediate hops — they are only transitioned to if
they are the explicit target.  The list is configured per-org via
`SLUICE_EXCLUDED_INTERMEDIATES` in `defaults.conf`.

### Transition Field Auto-Fill

Some Jira transition screens require fields even when those fields are
already populated on the issue.  Sluice auto-fills these from:

1. Configured defaults (WorkArea, Resolution)
2. The issue's current field values (echoed back to satisfy the screen)

If a required field can't be auto-filled, Sluice reports the error and
asks you to complete the transition manually in Jira.

## Security

### Credential Storage

- API tokens are stored in Google Apps Script `UserProperties`, scoped
  to the individual user and encrypted at rest by Google
- Tokens are never written to the spreadsheet or shared with
  collaborators
- The `defaults.conf` file (containing org-level configuration) is
  gitignored and never committed

### OAuth Scopes

Sluice requests only the minimum scopes needed:

| Scope                         | Purpose                        |
|-------------------------------|--------------------------------|
| `spreadsheets.currentonly`    | Read/write the bound sheet     |
| `script.external_request`     | HTTPS calls to Jira API        |
| `script.container.ui`         | Settings dialog and menu alerts|
| `userinfo.email`              | Identify the current user      |

### Input Validation

- **Base URL** — validated against `https://<org>.atlassian.net` to
  prevent credential leakage to arbitrary servers
- **Issue keys** — validated against `^[A-Z][A-Z0-9]+-\d+$` to prevent
  path traversal in API URLs
- **IDs** — filter IDs and transition IDs are validated as numeric
- **Linked keys** — parsed and validated before use in link operations

### Configuration Parsing

The `install.sh` script parses `defaults.conf` using a safe
key-value parser with a whitelisted set of known variable names.
Unrecognized keys are rejected with a warning.

### API Communication

- All Jira API calls use HTTPS (enforced by the base URL validation)
- Query parameters are URL-encoded via `encodeURIComponent()`
- Error responses are parsed and surfaced to the user with field-level
  detail

## Limitations

- **Jira Cloud only** — Sluice validates that the base URL matches
  `*.atlassian.net`.  Self-hosted Jira Server/Data Center instances are
  not supported without modifying the URL validation.

- **API token permissions** — Jira API tokens inherit the full
  permissions of the account that created them.  There is no way to
  scope a token to a specific project or set of operations.  For
  additional safety, use a dedicated Jira account with limited project
  permissions.

- **Simultaneous edits** — If both the sheet and Jira are edited between
  syncs, the Jira edit wins (last-write-wins based on timestamp).  There
  is no merge or per-field conflict resolution.

- **No real-time sync** — Sluice is manually triggered from the Sheets
  menu.  There is no automatic background polling or webhook-based push.

- **Workflow coverage** — multi-hop transitions depend on the workflow
  sequences declared via `SLUICE_WORKFLOW_*` keys in `defaults.conf`.
  If your Jira instance has issue types or workflow states not listed
  there, Sluice falls back to first-available transitions, which may
  not follow the intended path.  Add your workflows to `defaults.conf`
  and re-run `./install.sh` to fix this.

- **Google Sheets tables** — do not convert a Sluice-managed sheet into
  a Google Sheets "table".  Tables silently reformat cell contents to
  match inferred column types, which causes Sluice to detect false
  changes on every sync — even a simple sort inside a table can report
  dozens of rows as modified when nothing was edited.  Use a plain range
  instead; Sluice already provides frozen headers and hyperlinked Keys.

- **Additive link management** — Sluice creates missing issue links
  (DependsOn, Blocking) but removing a key from the sheet won't delete
  the link in Jira.  Link removal must be done in Jira directly.

- **Backward transitions** — some Jira workflows restrict backward
  movement (e.g., Done → Draft on Epics).  If the only available
  transition leads to an excluded status (Won't Fix, Blocked), Sluice
  reports an error rather than taking a potentially destructive path.

- **50-modification limit** — Sync blocks when more than 50 Jira issues
  would be created or updated in a single pass.  Pulls (sheet-only writes)
  are not limited.  Use narrower filters for larger modification sets.

- **Apps Script execution limits** — Google Apps Script enforces a
  6-minute execution timeout.  Syncs with many status transitions may
  hit this limit.

- **Rich text formatting** — Description and Bug text fields (Steps to
  Reproduce, Expected Result, Actual Results, Actual Outcomes) are stored
  as Markdown in the sheet and converted to/from Jira's ADF format.  Most
  formatting round-trips cleanly (headings, bold, italic, code, links,
  lists, blockquotes, tables), but some Jira-specific elements (panels,
  media, emoji) are simplified.

- **Custom field types** — select/dropdown, simple text, and ADF textarea
  custom fields are supported.  Multi-select and cascading selects are not
  handled.

- **Rate limiting** — Jira Cloud rate-limits API calls.  Sluice adds a
  500ms delay between multi-hop transition steps to avoid throttling,
  but very large push operations may still encounter rate limits.

## License

Apache License 2.0.  See [LICENSE](LICENSE) for details.

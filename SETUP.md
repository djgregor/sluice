# Sluice — Setup & Usage

Sluice is a Google Sheets add-on that provides bidirectional sync between
Google Sheets and Jira Cloud.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Team Defaults](#team-defaults)
- [First-Time Configuration](#first-time-configuration)
- [Sheet Tab Naming](#sheet-tab-naming)
- [Column Reference](#column-reference)
- [Pulling Issues from Jira](#pulling-issues-from-jira)
- [Bidirectional Sync](#bidirectional-sync)
- [Status Transitions](#status-transitions)
- [Issue Relationships](#issue-relationships)
- [Team Deployment](#team-deployment)
- [Safe Testing](#safe-testing)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## Prerequisites

- A Google account with access to Google Sheets
- A Jira Cloud instance (e.g. `https://yourorg.atlassian.net`)
- A Jira API token for your account
- Node.js (v18+) and `clasp` for CLI installation (optional for manual install)

### Creating a Jira API Token

1. Go to <https://id.atlassian.com/manage-profile/security/api-tokens>
2. Click **Create API token**
3. Give it a label (e.g. "Sluice")
4. Copy the token — you won't be able to see it again

Each team member needs their own API token.  Tokens are stored per-user in
Google Apps Script's `UserProperties`, so they are never visible to other
collaborators on the same sheet.

---

## Installation

### Quick Install (recommended)

One-time setup:

```bash
npm install -g @google/clasp    # install Google's Apps Script CLI
clasp login                     # authenticate with your Google account
```

If your system Node.js is restricted, install via `nvm` first:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install --lts
npm install -g @google/clasp
clasp login
```

Then install Sluice into any Google Sheet:

```bash
cd sluice
./install.sh
```

The installer offers two modes:

1. **Install into an existing sheet** — paste a Google Sheets URL or ID
2. **Create a new sheet** — enter a name for a brand new spreadsheet

You can also skip the interactive menu:

```bash
# Bind to an existing sheet
./install.sh "https://docs.google.com/spreadsheets/d/1aBcDeFgHiJk.../edit"

# Create a new sheet
./install.sh --new "Q1 Sprint Planning"
```

After installation, reload the Google Sheet.  The **Sluice** menu appears in
the menu bar.

To update an existing installation after code changes:

```bash
cd sluice
clasp push
```

> **Note:** `clasp` uses its own authentication, separate from `gcloud`.
> If you have multiple Google accounts, run `clasp logout && clasp login`
> to switch accounts.

### Manual Install (no CLI required)

If you can't use clasp (e.g. corporate Node.js restrictions):

1. Open your Google Sheet
2. Go to **Extensions → Apps Script**
3. Delete the default `Code.gs` content
4. For each `.gs` file in this directory, create a matching file in the
   Apps Script editor and paste the contents:
   - `Code.gs`, `Config.gs`, `JiraApi.gs`, `SheetMeta.gs`
   - `Pull.gs`, `Push.gs`, `Sync.gs`, `Workflows.gs`
5. For `Sidebar.html`, click **+** next to Files → **HTML** → name it
   `Sidebar` → paste the contents
6. Open `appsscript.json`:
   - In the Apps Script editor, click the gear icon (**Project Settings**)
   - Check **Show "appsscript.json" manifest file in editor**
   - Click `appsscript.json` in the sidebar and replace its contents
7. Click **Save** (Ctrl+S)
8. Reload the sheet — the **Sluice** menu will appear

For manual installs, team defaults (see below) must be configured by
creating a `Defaults.gs` file manually or entering all values in
Settings.

---

## Team Defaults

Sluice supports a shared defaults file so team members don't have to
configure everything from scratch.  Copy the example and fill in your
values:

```bash
cp defaults.conf.example defaults.conf
```

Available settings:

| Variable                | Description                                |
|-------------------------|--------------------------------------------|
| `SLUICE_BASE_URL`       | Jira instance URL (e.g. `https://yourorg.atlassian.net`) |
| `SLUICE_PROJECT`        | Default project key (e.g. `MYPROJ`)        |
| `SLUICE_LOE_FIELD`      | Custom field ID for Level of Effort (e.g. `customfield_10088`) |
| `SLUICE_WORKAREA_FIELD` | Custom field ID for WorkArea (e.g. `customfield_12504`) |
| `SLUICE_WORKAREA_VALUE` | Default WorkArea value for transitions        |
| `SLUICE_TEAM_FIELD`     | Custom field ID for Team (e.g. `customfield_10001`) |
| `SLUICE_TEAM_ID`        | Default Team UUID for issue creation       |
| `SLUICE_SPRINT_FIELD`       | Custom field ID for Sprint (read-only display)     |
| `SLUICE_STORY_POINTS_FIELD` | Custom field ID for Story Points (numeric, read/write) |
| `SLUICE_BUG_STEPS_FIELD`    | Custom field ID for "Steps to Reproduce" (Bug issues) |
| `SLUICE_BUG_EXPECTED_FIELD` | Custom field ID for "Expected Result" (Bug issues) |
| `SLUICE_BUG_ACTUAL_FIELD`   | Custom field ID for "Actual Results" (Bug issues) |
| `SLUICE_BUG_OUTCOMES_FIELD` | Custom field ID for "Actual Outcomes" (Bug issues) |

When `install.sh` runs, it generates a `Defaults.gs` file from these
values, which is baked into the Apps Script project.  Individual users
can override any default via **Sluice → Settings**.

> **Finding custom field IDs:** In the Apps Script editor, you can run a
> function that calls `jiraGet('/rest/api/3/field')` and searches the
> results by name.  Field IDs look like `customfield_NNNNN`.

The `defaults.conf` file is gitignored — it should never be committed to
version control since it contains organization-specific configuration.
The `defaults.conf.example` file is tracked as a template.

---

## First-Time Configuration

1. Open the sheet where Sluice is installed
2. Click **Sluice → Settings…** in the menu bar
3. Fill in:
   - **Jira Base URL** — e.g. `https://yourorg.atlassian.net`
   - **Email** — the email tied to your Jira account
   - **API Token** — the token you created above
   - **Default Project Key** — e.g. `MYPROJ` (used for creating new issues)
   - **LoE Days Field ID** — custom field ID for level-of-effort (optional)
   - **WorkArea Field ID** — custom field ID for work area (optional)
   - **WorkArea Default Value** — auto-filled during transitions that
     require it (optional)
   - **Team Field ID** — custom field ID for team assignment (optional)
   - **Team ID** — default team UUID for issue creation (optional)
   - **Sprint Field ID** — custom field for sprint name display (optional, read-only)
   - **Story Points Field ID** — custom field for estimation (optional, numeric)
   - **Bug Fields** (optional) — custom field IDs for Bug-specific textarea
     fields: Steps to Reproduce, Expected Result, Actual Results, Actual
     Outcomes.  These replace the standard Description field on Bug issues.
4. Click **Save**, then **Test Connection**
5. You should see "Connected as [Your Name]"

If team defaults were set during installation, the base URL, project key,
and custom field IDs will be pre-filled.  You only need to enter your
email and API token.

Each user configures their own credentials.  Credentials are never shared
between users or stored in the spreadsheet itself.

---

## Sheet Tab Naming

Sluice determines which Jira issues to sync by reading the sheet tab name.
Embed a Jira **saved filter ID** using braces or parentheses:

| Tab name               | Behavior                              |
|------------------------|---------------------------------------|
| `2025 Q1 {12345}`      | Syncs issues from Jira filter 12345   |
| `Sprint 42 (67890)`    | Same — parens also work               |
| `My Tasks`             | No filter ID — Sluice will show an error |

You can also store raw JQL in a **note on cell A1**:

```
sluice:jql=project = MYPROJ AND sprint in openSprints() ORDER BY rank ASC
```

### JQL Resolution Priority

1. Filter ID from sheet tab name (`{id}` or `(id)`)
2. Note on cell A1 (if it starts with `sluice:jql=`)

A filter ID or JQL note is **required**.  Sluice will not fall back to
pulling an entire project — this prevents accidentally syncing thousands
of issues.

### Filter Tips

**Exclude resolved issues.**  Jira board filters typically include all
issues — the board UI hides completed ones for you.  Sluice pulls
everything the filter returns, so your sheet will fill up with closed
tickets unless you exclude them:

```
AND status NOT IN (Closed, Done, "Won't fix", "Engineering is complete", Resolved)
```

Create this as a **new saved filter** in Jira (don't modify your board's
existing filter) and use its ID in the sheet tab name.

---

## Column Reference

You can use **any subset** of the columns below, in **any order**.  Set up
your header row (row 1) with the column names you want, and Sluice will
only read and write those columns.

If you pull into a sheet with no headers, Sluice creates the full default
header row automatically.

### Available Columns

| Column          | Jira Field     | Editable | Notes                                    |
|-----------------|----------------|----------|------------------------------------------|
| Type            | Issue Type     | Yes      | Task, Bug, Story, Epic, Sub-task, etc.   |
| Key             | Issue Key      | No       | e.g. MYPROJ-123; clickable link to Jira  |
| Priority        | Priority       | Yes      | P1, P2, etc. (matches your Jira scheme)  |
| Summary         | Summary        | Yes      | Issue title                              |
| Description     | Description    | Yes      | Markdown; converted to/from Jira's ADF   |
| Steps to Reproduce | Custom field | Yes     | Bug-specific; Markdown/ADF (configurable)|
| Expected Result | Custom field   | Yes      | Bug-specific; Markdown/ADF (configurable)|
| Actual Results  | Custom field   | Yes      | Bug-specific; Markdown/ADF (configurable)|
| Actual Outcomes | Custom field   | Yes      | Bug-specific; Markdown/ADF (configurable)|
| Environment     | Environment    | Yes      | Markdown/ADF; typically used on Bugs     |
| Assignee        | Assignee       | Yes      | Jira display name or email               |
| Status          | Status         | Yes      | Triggers workflow transitions in Jira    |
| Resolution      | Resolution     | No       | e.g. Done, Won't Fix (set via transitions)|
| Sprint          | Custom field   | No       | Sprint name display (configurable)       |
| LoE Days        | Custom field   | Yes      | Level-of-effort estimate (configurable)  |
| Story Points    | Custom field   | Yes      | Numeric estimation (configurable)        |
| Target End Date | Due Date       | Yes      | Format: YYYY-MM-DD                       |
| DependsOn       | Issue Link     | Yes      | Comma-separated keys (e.g. MYPROJ-100)   |
| Parent          | Parent         | Yes      | Parent issue key for sub-tasks           |
| Children        | Subtasks       | No       | Auto-populated from Jira                 |
| Blocking        | Issue Link     | Yes      | Comma-separated keys this issue blocks   |
| Component       | Components     | Yes      | Comma-separated component names          |
| Reporter        | Reporter       | Yes      | Jira display name or email               |
| Labels          | Labels         | Yes      | Comma-separated labels                   |
| Fix Versions    | Fix Versions   | Yes      | Comma-separated version names            |
| WorkArea        | Custom field   | Yes      | Select/dropdown (configurable field ID)  |
| Created         | Created        | No       | ISO timestamp of issue creation          |
| Updated         | Updated        | No       | ISO timestamp of last Jira modification  |
| Last Synced     | —              | No       | Timestamp used for conflict resolution   |

### Choosing Your Columns

A minimal useful set:

```
Type | Key | Priority | Summary | Description | Assignee | Status | Component | Labels
```

**Column names must match exactly** (case-sensitive).  You can add your own
extra columns to the right — Sluice won't touch them.

**Required for push/sync:** Key and Summary.  Without Key, Sluice can't
identify which Jira issue a row maps to.  Without Summary, Sluice can't
create new issues.

**Required for bidirectional sync:** Last Synced.  Without it, Sync can't
determine which side was edited more recently, so it defaults to always
pulling from Jira.

**Standard fields you can add freely:** Environment, Resolution, Fix
Versions, Created, and Updated work out of the box with no configuration.
Just add the column header to your sheet.

**Agile columns (Sprint, Story Points):** These are custom fields in Jira
Cloud and their field IDs vary by instance.  Configure them in Settings
under **Agile** before adding the column headers.  Sprint is read-only
(displays the sprint name).  Story Points is read/write (numeric).

**Bug-specific columns:** Some Jira instances disable the standard
Description field on Bug issues, replacing it with structured fields like
"Steps to Reproduce", "Expected Result", "Actual Results", and "Actual
Outcomes".  Configure the custom field IDs in Settings under **Bug Fields**
and add the corresponding columns to your sheet.  These columns use
Markdown/ADF conversion just like Description.  For non-Bug issue types
these columns will be empty.

---

## Pulling Issues from Jira

**Sluice → Pull from Jira** fetches all issues matching the active sheet's
JQL and writes them into the sheet.

### How It Works

1. Resolves the JQL for the current sheet tab
2. Shows the JQL and asks for confirmation
3. Fetches all matching issues (paginated, up to 5000)
4. Creates a header row if none exists
5. For each issue:
   - Row with that Key exists → updates it in place
   - Issue is new → appends a row
6. Stamps "Last Synced" on every updated/appended row

Pull is **non-destructive** — it never deletes rows.  If an issue no longer
matches the filter, its row stays but won't be updated.

### Tips

- Pull into an empty sheet for the cleanest starting point
- Extra columns to the right of standard columns are untouched
- Large result sets (500+ issues) may take 10–30 seconds

---

## Bidirectional Sync

**Sluice → Sync Sheet ↔ Jira** is the primary workflow action.  It combines
Pull and Push with automatic conflict resolution.

### How It Works

1. Fetches all issues matching the sheet's JQL from Jira
2. Reads all rows from the sheet
3. For each row with a Key, determines the sync direction:

| Scenario | Direction | Reasoning |
|----------|-----------|-----------|
| Row has no Key | Push (create) | New issue defined in the sheet |
| Row has Key, no Last Synced | Pull | First sync — Jira is source of truth |
| Jira `updated` > Last Synced | Pull (Jira wins) | Issue edited in Jira since last sync |
| Jira `updated` ≤ Last Synced, row differs | Push (Sheet wins) | Local edits in the sheet |
| Jira `updated` ≤ Last Synced, row matches | Skip | No changes on either side |
| Jira issue not in sheet | Pull (append) | New issue appeared in filter results |
| Sheet Key not in Jira results | Skip | Issue left filter scope — not touched |

4. New Jira issues not in the sheet are appended as new rows
5. All touched rows get a fresh "Last Synced" timestamp

### Scope Safety

Sync **only modifies issues** that appear in the current filter's results.
If a Key is in the sheet but the issue no longer matches the filter JQL,
Sync will not push changes to it.  This prevents accidentally modifying
issues outside your intended scope.

### Last-Write-Wins

- `Last Synced` records when a row was last synchronized
- Jira's `updated` records when the issue was last modified
- If Jira was modified **after** Last Synced → Jira wins
- If Jira was **not** modified since Last Synced → sheet wins

If both sides are edited between syncs, the Jira edit wins.  To ensure
sheet edits take priority, sync frequently.

> **Timing detail:** Sluice stamps "Last Synced" _after_ all operations
> (field update, link creation, status transitions) are complete, using a
> fresh timestamp.  This ensures the Last Synced value is always newer than
> any Jira `updated` timestamp caused by the sync itself.

---

## Status Transitions

Jira workflows don't allow arbitrary status jumps — you must follow defined
transitions.  Sluice handles this automatically via multi-hop walking.

### How It Works

When you change a status in the sheet (e.g., "Draft" → "Done"):

1. Sluice looks up the issue type's workflow sequence in `Workflows.gs`
2. Identifies the next intermediate status in the sequence
3. Checks available Jira transitions for a match
4. Executes the transition, auto-filling any required fields
5. Repeats until the target status is reached (up to 8 hops)

### Defined Workflow Sequences

| Issue Type      | Sequence |
|-----------------|----------|
| Task            | Draft → TO DO → In Progress → Verifying → Done |
| Spike           | Draft → TO DO → In Progress → Verifying → Done |
| Bug             | Triage → TO DO → Dev In Progress → Resolved → Ready For QA → QA In Progress → Done |
| Tech Story      | Draft → Ready for Grooming → Dev In Progress → Review → Done |
| Story           | Draft → BA in Progress → Dev In Progress → Done |
| Epic            | Draft → Scheduled for Analysis → Analyzing → Analyzed |
| Service Request | Draft → TO DO → In Progress → Verifying → Done |

These sequences are defined in `Workflows.gs` and can be customized for
your Jira instance.  Status names are matched case-insensitively.

### Transition Priority

At each hop, Sluice selects the transition to execute in this order:

1. **Direct** — a transition straight to the target status (always preferred)
2. **Sequence** — the next step in the defined workflow sequence
3. **Fallback** — the first available unvisited, non-terminal transition

### Excluded Intermediates

The following statuses are never used as intermediate stepping stones:

- Won't Fix
- Blocked
- Descope Task
- Cancelled / Canceled

These are only transitioned to if they are the explicit target status.

### Transition Field Auto-Fill

Some Jira transition screens mark fields as "required" even when they are
already populated on the issue.  Sluice auto-fills these from:

1. **Configured defaults** — WorkArea (from Settings) and Resolution
   (defaults to "Done")
2. **Current issue values** — the issue's existing field values are echoed
   back to satisfy the transition screen

If a required field can't be auto-filled from either source, Sluice reports
the error and asks you to complete the transition manually in Jira.

### Backward Transitions

Some workflows restrict backward movement.  For example, once an Epic is
"Done", the only available transition may be "Won't Fix", which Sluice
excludes as an intermediate.  In these cases, Sluice reports an error
rather than taking a potentially destructive path.

---

## Issue Relationships

Sluice manages three types of issue relationships:

### Parent/Child

Set the **Parent** column to a Jira issue key (e.g. `MYPROJ-100`).  On
push, the issue is linked as a child of that parent.

**Creating hierarchies from scratch:**

1. Add the parent row (Type, Summary, etc.) — leave Key blank
2. Push to Jira — the parent Key is written back (e.g. `MYPROJ-100`)
3. Add child rows with `MYPROJ-100` in the Parent column
4. Push again — children are created with the parent link

### DependsOn

Comma-separated list of issue keys that this issue depends on (is blocked
by).  Example: `MYPROJ-50, MYPROJ-51`

### Blocking

Comma-separated list of issue keys that this issue blocks.  Example:
`MYPROJ-60, MYPROJ-61`

### Link Management

- Sluice creates missing links on push/sync
- Links present in Jira but not in the sheet are **not removed** — link
  removal must be done directly in Jira
- Issue keys in link columns are validated before use

---

## Team Deployment

### Option 1: Template Sheet (recommended)

1. Install Sluice into a "template" sheet
2. Team members copy the template (**File → Make a copy**)
3. The Apps Script project is copied along with the sheet
4. Each user configures their own credentials via **Sluice → Settings**

### Option 2: Google Workspace Add-on (advanced)

For organization-wide deployment:

1. Create a standalone Apps Script project with this code
2. Deploy as a Google Workspace Add-on via the Marketplace SDK
3. An admin can install it for the entire domain
4. Sluice appears automatically in every user's Sheets

This requires a Google Cloud project and Workspace admin approval.

### Option 3: clasp + Shared Defaults

1. Check the code into your team's repo
2. Each member fills in `defaults.conf` with shared org values
3. Run `./install.sh` to install into their own sheet
4. Only email + API token differ per user

---

## Safety Limits

Sluice enforces limits on **Jira modifications** (creates and updates) to
prevent accidentally changing large numbers of issues:

| Jira modifications | Behavior |
|--------------------|----------|
| 1–20               | Simple Yes/No confirmation |
| 21–50              | Typed "Yes" confirmation required |
| 51+                | **Blocked** — narrow your filter or run multiple passes |

These limits apply to **Sync** only and count potential Jira-side writes
(new issues to create + existing issues that could be updated).  Operations
that only write to the sheet — pulls and appends — are not limited, since
they are safe and reversible.

**Pull** has no hard limit.  It confirms the issue count after fetching and
is naturally capped by the Max Issues per Sync setting (default 1000).

If you need to modify more than 50 issues, use more specific Jira filters
(e.g. by assignee, sprint, or label) and run multiple passes.

---

## Safe Testing

Before using Sluice against a large project, test with a narrow filter:

```
project = "MYPROJ" AND assignee = currentUser() AND status = "In Progress"
```

Create a Jira saved filter with this JQL, note the filter ID, and use it
in your sheet tab name (e.g. `Test {12345}`).  This ensures:

- Pull only fetches those few issues
- Sync only pushes changes for issues in the filter results
- Nothing outside your filter can be touched via Sync

Once you're confident, switch to your real filter.

> **Note:** Jira API tokens inherit the full permissions of your account —
> they cannot be scoped.  If you want extra safety, create a dedicated Jira
> account with limited project permissions.

---

## Security

### Credential Storage

- API tokens are stored in Google Apps Script `UserProperties`, scoped to
  the individual user and encrypted at rest by Google
- Tokens are never written to the spreadsheet, logged, or shared with
  collaborators
- `defaults.conf` is gitignored and never committed to version control

### OAuth Scopes

Sluice requests only the minimum OAuth scopes:

| Scope                         | Purpose                        |
|-------------------------------|--------------------------------|
| `spreadsheets.currentonly`    | Read/write the bound sheet     |
| `script.external_request`     | HTTPS calls to Jira API        |
| `script.container.ui`         | Settings dialog and menu alerts|
| `userinfo.email`              | Identify the current user      |

### Input Validation

- **Base URL** — validated to match `https://<org>.atlassian.net`, preventing
  credential leakage to arbitrary servers
- **Issue keys** — validated against `^[A-Z][A-Z0-9]+-\d+$` before use in
  API paths, preventing path traversal attacks
- **Numeric IDs** — filter IDs and transition IDs are validated as numeric
- **Link targets** — parsed and regex-validated before use in API calls
- **Query parameters** — URL-encoded via `encodeURIComponent()`

### Configuration Security

The `install.sh` script uses a safe key-value parser for `defaults.conf`
with a whitelisted set of known variable names.  Unrecognized keys are
rejected with a warning.  This prevents arbitrary command execution
through the configuration file.

### API Communication

- All API calls use HTTPS (enforced by the base URL validation)
- Errors are parsed and surfaced with field-level detail for debugging
  without exposing raw API responses to the spreadsheet

---

## Troubleshooting

**"Sluice" menu doesn't appear**
- Reload the sheet (Ctrl+R / Cmd+R).  The menu is created by `onOpen()`.
- After first install, you may need to reload twice.

**"Missing configuration" error**
- Open **Sluice → Settings** and fill in all required fields (Base URL,
  Email, API Token).

**"Jira base URL must be https://\<org\>.atlassian.net"**
- Sluice only supports Jira Cloud.  Ensure your base URL is in the format
  `https://yourorg.atlassian.net` with no trailing slash or path.

**"HTTP 401" on Test Connection**
- Verify your email and API token.  Tokens are generated at
  id.atlassian.com, not your Jira password.

**"HTTP 403" when syncing**
- Your Jira account may not have permission to view/edit the target project.

**Status change fails with "No path from X to Y"**
- The target status isn't reachable from the current status via available
  transitions.  Check if the workflow sequence for this issue type is
  defined in `Workflows.gs`.

**Status change fails with "requires fields"**
- A transition screen requires a field that Sluice can't auto-fill.
  Complete the transition manually in Jira, or add the field to the
  defaults in `Workflows.gs`.

**"HTTP 400" on sync/update**
- Usually a field validation error.  The error message includes Jira's
  field-level error details.  Common causes: invalid component name,
  unresolvable user, or a custom field not on the issue's edit screen.

**"Address unavailable" during transitions**
- Transient Jira API throttling.  Sluice includes a 500ms delay between
  multi-hop transitions, but heavy usage may still trigger rate limits.
  Wait a moment and retry.

**Sync pulls from Jira instead of pushing sheet edits**
- This is expected if someone edited the issue in Jira after your last
  sync (Jira's `updated` timestamp is newer than `Last Synced`).  To
  ensure your sheet edits win, sync more frequently so that `Last Synced`
  stays ahead of Jira's `updated` timestamp.

**clasp uses the wrong Google account**
- Run `clasp logout && clasp login` and authenticate with the correct
  account.  `clasp` maintains its own auth in `~/.clasprc.json`,
  separate from `gcloud`.

---

## Limitations

- **Jira Cloud only** — self-hosted Jira Server/Data Center is not
  supported (base URL is validated against `*.atlassian.net`)
- **No real-time sync** — manually triggered from the Sheets menu
- **Last-write-wins only** — no per-field merge; if both sides edit
  between syncs, Jira wins
- **Additive link management** — DependsOn and Blocking relationships are
  created in Jira but not removed; deleting a key from the sheet won't
  delete the link in Jira
- **50-modification limit** — Sync blocks when more than 50 Jira issues
  would be created or updated; use narrower filters and multiple passes
- **6-minute execution limit** — Google Apps Script timeout may affect
  syncs with many status transitions
- **Description formatting** — Description and Bug text fields (Steps to
  Reproduce, Expected Result, etc.) are stored as Markdown in the sheet
  and converted to/from Jira's ADF format.  Most formatting round-trips
  cleanly (headings, bold, italic, code, links, lists, blockquotes,
  tables), but some Jira-specific elements (panels, media, emoji) are
  simplified
- **Custom field types** — only select/dropdown, simple text, and ADF
  textarea custom fields are supported; multi-select is not handled
- **API rate limits** — very large push operations may encounter Jira
  Cloud rate limits despite built-in delays
- **Backward transitions** — some workflows restrict backward movement;
  Sluice won't use terminal statuses as intermediates
- **API token scope** — Jira tokens inherit full account permissions;
  use a dedicated account for additional safety
- **Google Sheets tables are not supported** — do not convert a
  Sluice-managed sheet into a Google Sheets "table" (the Format → Convert
  to table feature).  Tables apply column types that silently reformat
  cell contents, which causes Sluice to detect false changes on every
  sync — sorting or filtering inside a table can report dozens of rows
  as modified even when nothing was edited.  Use a plain range; Sluice
  already provides frozen headers and clickable Key links.  If you have
  an existing table, right-click → Table → Convert to range and re-pull

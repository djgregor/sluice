#!/usr/bin/env bash
#
# Sluice installer — creates or binds an Apps Script project to a Google Sheet
# and pushes the Sluice code.
#
# Usage:
#   ./install.sh                     # interactive — choose new or existing sheet
#   ./install.sh SHEET_URL           # bind to an existing sheet (URL or ID)
#   ./install.sh --new "Sheet Name"  # create a new sheet with the given name
#
# Shared defaults (base URL, project key, custom field IDs) are defined in
# defaults.conf in this directory. Edit that file before installing to
# customize for your team.
#
# Prerequisites:
#   - Node.js (v18+)
#   - npm install -g @google/clasp
#   - clasp login (one-time)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# --- Check prerequisites ---------------------------------------------------

if ! command -v clasp &>/dev/null; then
  echo "Error: 'clasp' is not installed."
  echo ""
  echo "Install it with:"
  echo "  npm install -g @google/clasp"
  echo ""
  echo "Then log in:"
  echo "  clasp login"
  exit 1
fi

# --- Load defaults ----------------------------------------------------------

DEFAULTS_FILE="$SCRIPT_DIR/defaults.conf"

if [[ ! -f "$DEFAULTS_FILE" ]]; then
  if [[ -f "$SCRIPT_DIR/defaults.conf.example" ]]; then
    echo "No defaults.conf found. Creating from defaults.conf.example..."
    echo "Edit defaults.conf with your team's values, then re-run this script."
    echo ""
    cp "$SCRIPT_DIR/defaults.conf.example" "$DEFAULTS_FILE"
    exit 0
  else
    echo "Warning: No defaults.conf found. Shared defaults will not be set."
    echo "Copy defaults.conf.example to defaults.conf and fill in your values."
    echo ""
  fi
fi

# Initialize all variables to empty (in case defaults.conf omits some)
SLUICE_BASE_URL="${SLUICE_BASE_URL:-}"
SLUICE_PROJECT="${SLUICE_PROJECT:-}"
SLUICE_LOE_FIELD="${SLUICE_LOE_FIELD:-}"
SLUICE_WORKAREA_FIELD="${SLUICE_WORKAREA_FIELD:-}"
SLUICE_WORKAREA_VALUE="${SLUICE_WORKAREA_VALUE:-}"
SLUICE_TEAM_FIELD="${SLUICE_TEAM_FIELD:-}"
SLUICE_TEAM_ID="${SLUICE_TEAM_ID:-}"
SLUICE_SPRINT_FIELD="${SLUICE_SPRINT_FIELD:-}"
SLUICE_STORY_POINTS_FIELD="${SLUICE_STORY_POINTS_FIELD:-}"
SLUICE_BUG_STEPS_FIELD="${SLUICE_BUG_STEPS_FIELD:-}"
SLUICE_BUG_EXPECTED_FIELD="${SLUICE_BUG_EXPECTED_FIELD:-}"
SLUICE_BUG_ACTUAL_FIELD="${SLUICE_BUG_ACTUAL_FIELD:-}"
SLUICE_BUG_OUTCOMES_FIELD="${SLUICE_BUG_OUTCOMES_FIELD:-}"

# Parse defaults.conf safely — only allow known variable names with simple values.
# This avoids executing arbitrary commands that 'source' would allow.
if [[ -f "$DEFAULTS_FILE" ]]; then
  while IFS='=' read -r key value; do
    # Skip comments and blank lines
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
    # Strip surrounding whitespace from key
    key="$(echo "$key" | xargs)"
    # Strip surrounding quotes from value
    value="${value#\"}"
    value="${value%\"}"
    value="${value#\'}"
    value="${value%\'}"
    # Only accept known config keys
    case "$key" in
      SLUICE_BASE_URL)      SLUICE_BASE_URL="$value" ;;
      SLUICE_PROJECT)       SLUICE_PROJECT="$value" ;;
      SLUICE_LOE_FIELD)     SLUICE_LOE_FIELD="$value" ;;
      SLUICE_WORKAREA_FIELD) SLUICE_WORKAREA_FIELD="$value" ;;
      SLUICE_WORKAREA_VALUE) SLUICE_WORKAREA_VALUE="$value" ;;
      SLUICE_TEAM_FIELD)    SLUICE_TEAM_FIELD="$value" ;;
      SLUICE_TEAM_ID)       SLUICE_TEAM_ID="$value" ;;
      SLUICE_SPRINT_FIELD)       SLUICE_SPRINT_FIELD="$value" ;;
      SLUICE_STORY_POINTS_FIELD) SLUICE_STORY_POINTS_FIELD="$value" ;;
      SLUICE_BUG_STEPS_FIELD)    SLUICE_BUG_STEPS_FIELD="$value" ;;
      SLUICE_BUG_EXPECTED_FIELD) SLUICE_BUG_EXPECTED_FIELD="$value" ;;
      SLUICE_BUG_ACTUAL_FIELD)   SLUICE_BUG_ACTUAL_FIELD="$value" ;;
      SLUICE_BUG_OUTCOMES_FIELD) SLUICE_BUG_OUTCOMES_FIELD="$value" ;;
      *) echo "Warning: unknown config key '$key' in defaults.conf (ignored)" ;;
    esac
  done < "$DEFAULTS_FILE"
fi

# --- Helpers ----------------------------------------------------------------

extract_sheet_id() {
  local input="$1"
  if [[ "$input" =~ /d/([a-zA-Z0-9_-]+) ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    echo "$input"
  fi
}

# --- Parse arguments --------------------------------------------------------

MODE=""
SHEET_ID=""
SHEET_TITLE=""

if [[ $# -ge 1 ]]; then
  if [[ "$1" == "--new" ]]; then
    MODE="new"
    SHEET_TITLE="${2:-}"
    if [[ -z "$SHEET_TITLE" ]]; then
      echo "Error: --new requires a sheet name."
      echo "  Usage: ./install.sh --new \"My Sheet Name\""
      exit 1
    fi
  else
    MODE="existing"
    SHEET_ID=$(extract_sheet_id "$1")
  fi
fi

# --- Interactive mode -------------------------------------------------------

if [[ -z "$MODE" ]]; then
  echo "Sluice — Google Sheets ↔ Jira Sync"
  echo ""
  echo "Shared defaults:"
  echo "  Base URL:        ${SLUICE_BASE_URL:-(not set)}"
  echo "  Project Key:     ${SLUICE_PROJECT:-(not set)}"
  echo "  LoE Field:       ${SLUICE_LOE_FIELD:-(not set)}"
  echo "  WorkArea Field:  ${SLUICE_WORKAREA_FIELD:-(not set)}"
  echo "  WorkArea Value:  ${SLUICE_WORKAREA_VALUE:-(not set)}"
  echo "  Team Field:      ${SLUICE_TEAM_FIELD:-(not set)}"
  echo "  Team ID:         ${SLUICE_TEAM_ID:-(not set)}"
  echo "  Sprint Field:    ${SLUICE_SPRINT_FIELD:-(not set)}"
  echo "  Story Points:    ${SLUICE_STORY_POINTS_FIELD:-(not set)}"
  echo "  Bug Steps Field: ${SLUICE_BUG_STEPS_FIELD:-(not set)}"
  echo "  Bug Expected:    ${SLUICE_BUG_EXPECTED_FIELD:-(not set)}"
  echo "  Bug Actual:      ${SLUICE_BUG_ACTUAL_FIELD:-(not set)}"
  echo "  Bug Outcomes:    ${SLUICE_BUG_OUTCOMES_FIELD:-(not set)}"
  echo ""
  echo "  To change these, edit: defaults.conf"
  echo ""
  echo "  1) Install into an existing Google Sheet"
  echo "  2) Create a new Google Sheet"
  echo ""
  read -rp "Choose [1/2]: " choice

  case "$choice" in
    2)
      MODE="new"
      read -rp "Sheet name: " SHEET_TITLE
      if [[ -z "$SHEET_TITLE" ]]; then
        echo "Error: Sheet name cannot be empty."
        exit 1
      fi
      ;;
    *)
      MODE="existing"
      echo ""
      read -rp "Paste your Google Sheet URL or ID: " input
      SHEET_ID=$(extract_sheet_id "$input")
      ;;
  esac
fi

# --- Validate ---------------------------------------------------------------

if [[ "$MODE" == "existing" && -z "$SHEET_ID" ]]; then
  echo "Error: Could not determine sheet ID."
  exit 1
fi

# --- Check if already installed ---------------------------------------------

if [[ -f .clasp.json ]]; then
  echo ""
  echo "Warning: .clasp.json already exists in this directory."
  echo "This means Sluice was previously installed from here."
  echo ""
  read -rp "Overwrite and reinstall? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy] ]]; then
    echo "Aborted."
    exit 0
  fi
  rm -f .clasp.json
fi

# --- Generate Defaults.gs --------------------------------------------------

HAS_DEFAULTS=false
DEFAULTS_BODY=""

add_default() {
  local key="$1" value="$2"
  if [[ -n "$value" ]]; then
    value="${value//\'/\\\'}"
    if $HAS_DEFAULTS; then
      DEFAULTS_BODY+=","
    fi
    DEFAULTS_BODY+=$'\n'"  $key: '$value'"
    HAS_DEFAULTS=true
  fi
}

add_default "jiraBaseUrl"   "${SLUICE_BASE_URL:-}"
add_default "jiraProject"   "${SLUICE_PROJECT:-}"
add_default "loeField"      "${SLUICE_LOE_FIELD:-}"
add_default "workAreaField" "${SLUICE_WORKAREA_FIELD:-}"
add_default "workAreaValue" "${SLUICE_WORKAREA_VALUE:-}"
add_default "teamField"     "${SLUICE_TEAM_FIELD:-}"
add_default "teamId"        "${SLUICE_TEAM_ID:-}"
add_default "sprintField"       "${SLUICE_SPRINT_FIELD:-}"
add_default "storyPointsField" "${SLUICE_STORY_POINTS_FIELD:-}"
add_default "bugStepsField"    "${SLUICE_BUG_STEPS_FIELD:-}"
add_default "bugExpectedField" "${SLUICE_BUG_EXPECTED_FIELD:-}"
add_default "bugActualField"   "${SLUICE_BUG_ACTUAL_FIELD:-}"
add_default "bugOutcomesField" "${SLUICE_BUG_OUTCOMES_FIELD:-}"

if $HAS_DEFAULTS; then
  cat > Defaults.gs <<GSEOF
/**
 * Sluice — Shared defaults (generated by install.sh)
 *
 * These values are used as fallbacks when a user has not configured
 * their own settings via Sluice → Settings. Team members only need
 * to enter their email and API token.
 *
 * To change these defaults, edit defaults.conf and re-run install.sh
 * (or edit this file directly and run: clasp push)
 */
var SLUICE_DEFAULTS = {${DEFAULTS_BODY}
};
GSEOF
else
  rm -f Defaults.gs
fi

# --- Create the Apps Script project -----------------------------------------

echo ""
if [[ "$MODE" == "new" ]]; then
  echo "Creating new Google Sheet: $SHEET_TITLE"
  clasp create --type sheets --title "$SHEET_TITLE" --rootDir .
else
  echo "Sheet ID: $SHEET_ID"
  echo "Creating Apps Script project bound to sheet..."
  clasp create --parentId "$SHEET_ID" --title "Sluice" --rootDir .
fi

echo ""
echo "Pushing code to Apps Script..."
clasp push

echo ""
echo "============================================"
echo " Sluice installed successfully!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Reload your Google Sheet"
echo "  2. The 'Sluice' menu will appear in the menu bar"
echo "  3. Click Sluice → Settings to configure your Jira connection"
if $HAS_DEFAULTS; then
  echo "     (Shared defaults are pre-filled — just add your email + API token)"
fi
echo ""
echo "To update the code later, run:"
echo "  cd $SCRIPT_DIR && clasp push"
echo ""
echo "To open the Apps Script editor:"
echo "  clasp open"
echo ""

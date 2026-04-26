/**
 * Sluice - Sheet metadata & naming conventions
 *
 * Parses sheet tab names to extract Jira filter IDs or raw JQL,
 * using the convention:
 *
 *   "2025 Q1 {12345}"   -> filter ID 12345
 *   "Sprint 42 (67890)" -> saved search / filter ID 67890 (alt syntax)
 *   "My Tasks"          -> no embedded filter; Sluice will show an error
 *
 * Also manages the hidden metadata row (row 1) that stores column
 * mappings and last-sync timestamps.
 */

/* Sheet-name parsing */

/**
 * Extract a Jira filter ID from the sheet tab name.
 * Supports {id} and (id) syntax.
 *
 * @param {string} sheetName
 * @return {string|null} filter ID or null
 */
function parseFilterId(sheetName) {
  // {12345} or (12345)
  const m = sheetName.match(/[{(](\d+)[})]/);
  return m ? m[1] : null;
}

/**
 * Resolve the JQL to use for a given sheet.
 * Priority:
 *   1. Filter ID embedded in sheet name -> fetch filter's JQL from Jira
 *   2. JQL stored in a note on cell A1
 *   3. Error — a filter or JQL note is required
 *
 * @param {Sheet} sheet
 * @return {Object} { jql: string, source: string, error: string|null }
 */
function resolveSheetJql(sheet) {
  const sheetName = sheet.getName();

  // 1. Try filter ID from sheet name
  const filterId = parseFilterId(sheetName);
  if (filterId) {
    const filter = jiraGetFilter(filterId);
    if (filter.error) {
      return { jql: null, source: 'filter', error: 'Could not load filter ' + filterId + ': ' + filter.error };
    }
    return { jql: filter.jql, source: 'filter:' + filterId, error: null };
  }

  // 2. Check for JQL stored in a note on A1
  const noteJql = sheet.getRange('A1').getNote();
  if (noteJql && noteJql.indexOf('sluice:jql=') === 0) {
    return { jql: noteJql.substring('sluice:jql='.length), source: 'note', error: null };
  }

  // No fallback — require an explicit filter or JQL
  return {
    jql: null,
    source: 'none',
    error: 'No filter ID found in the sheet tab name.\n\n' +
      'Embed a Jira saved filter ID in the tab name, e.g.:\n' +
      '  "2025 Q1 {12345}" or "Sprint 42 (67890)"\n\n' +
      'Or add a note on cell A1 starting with:\n' +
      '  sluice:jql=your JQL here'
  };
}

/* Standard column definitions */

/**
 * The canonical column order. Each entry maps a header label to the
 * Jira REST field path used during sync.
 *
 * Columns marked readOnly are populated from Jira but never pushed back.
 */
const SLUICE_COLUMNS = [
  { header: 'Type',            jiraField: 'issuetype',    readOnly: false },
  { header: 'Key',             jiraField: 'key',          readOnly: true  },
  { header: 'Priority',        jiraField: 'priority',     readOnly: false },
  { header: 'Summary',         jiraField: 'summary',      readOnly: false },
  { header: 'Description',     jiraField: 'description',  readOnly: false },
  { header: 'Steps to Reproduce', jiraField: '_custom_bug_steps_',    readOnly: false },
  { header: 'Expected Result',    jiraField: '_custom_bug_expected_',  readOnly: false },
  { header: 'Actual Results',     jiraField: '_custom_bug_actual_',    readOnly: false },
  { header: 'Actual Outcomes',    jiraField: '_custom_bug_outcomes_',  readOnly: false },
  { header: 'Environment',     jiraField: 'environment',  readOnly: false },
  { header: 'Assignee',        jiraField: 'assignee',     readOnly: false },
  { header: 'Status',          jiraField: 'status',       readOnly: false },
  { header: 'Resolution',      jiraField: 'resolution',   readOnly: true  },
  { header: 'Sprint',          jiraField: '_custom_sprint_', readOnly: true },
  { header: 'LoE Days',        jiraField: '_custom_',         readOnly: false },  // mapped via Settings
  { header: 'Story Points',    jiraField: '_custom_sp_',      readOnly: false },  // mapped via Settings
  { header: 'Target End Date', jiraField: 'duedate',      readOnly: false },
  { header: 'DependsOn',       jiraField: 'link:Depends', readOnly: false },
  { header: 'Parent',          jiraField: 'parent',       readOnly: false },
  { header: 'Children',        jiraField: 'subtasks',     readOnly: true  },
  { header: 'Blocking',        jiraField: 'link:Blocks',  readOnly: false },
  { header: 'Component',       jiraField: 'components',   readOnly: false },
  { header: 'Reporter',        jiraField: 'reporter',     readOnly: false },
  { header: 'Labels',          jiraField: 'labels',       readOnly: false },
  { header: 'Fix Versions',    jiraField: 'fixVersions',  readOnly: false },
  { header: 'WorkArea',        jiraField: '_custom_wa_',  readOnly: false },
  { header: 'Created',         jiraField: 'created',      readOnly: true  },
  { header: 'Updated',         jiraField: 'updated',      readOnly: true  },
  { header: 'Status Since',    jiraField: 'statuscategorychangedate', readOnly: true },
  { header: 'Last Synced',     jiraField: '_sluice_sync', readOnly: true  }
];

/**
 * Return the resolved column definitions, substituting the configured
 * custom field ID for LoE Days (if set).
 */
function getResolvedColumns() {
  const cfg = getConfig();
  return SLUICE_COLUMNS.map(function (col) {
    if (col.jiraField === '_custom_' && cfg.loeField) {
      return { header: col.header, jiraField: cfg.loeField, readOnly: col.readOnly };
    }
    if (col.jiraField === '_custom_wa_' && cfg.workAreaField) {
      return { header: col.header, jiraField: cfg.workAreaField, readOnly: col.readOnly };
    }
    if (col.jiraField === '_custom_bug_steps_' && cfg.bugStepsField) {
      return { header: col.header, jiraField: cfg.bugStepsField, readOnly: col.readOnly };
    }
    if (col.jiraField === '_custom_bug_expected_' && cfg.bugExpectedField) {
      return { header: col.header, jiraField: cfg.bugExpectedField, readOnly: col.readOnly };
    }
    if (col.jiraField === '_custom_bug_actual_' && cfg.bugActualField) {
      return { header: col.header, jiraField: cfg.bugActualField, readOnly: col.readOnly };
    }
    if (col.jiraField === '_custom_bug_outcomes_' && cfg.bugOutcomesField) {
      return { header: col.header, jiraField: cfg.bugOutcomesField, readOnly: col.readOnly };
    }
    if (col.jiraField === '_custom_sprint_' && cfg.sprintField) {
      return { header: col.header, jiraField: cfg.sprintField, readOnly: col.readOnly };
    }
    if (col.jiraField === '_custom_sp_' && cfg.storyPointsField) {
      return { header: col.header, jiraField: cfg.storyPointsField, readOnly: col.readOnly };
    }
    return col;
  });
}

/**
 * Write the header row into a sheet (row 1).
 */
function writeHeaderRow(sheet) {
  const headers = SLUICE_COLUMNS.map(function (c) { return c.header; });
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#4a86c8')
    .setFontColor('#ffffff');
  sheet.setFrozenRows(1);
}

/**
 * Read the header row from a sheet and return a map of header -> column index (1-based).
 */
function readHeaderMap(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  for (let i = 0; i < headers.length; i++) {
    if (headers[i]) {
      map[headers[i].toString().trim()] = i + 1;
    }
  }
  return map;
}

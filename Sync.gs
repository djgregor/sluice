/**
 * Sluice - Bidirectional Sync (Sheet <-> Jira)
 *
 * Combines Pull and Push into a single operation with last-write-wins
 * conflict resolution:
 *
 *   For each row with a Key that exists in Jira:
 *     - If Jira's "updated" > row's "Last Synced" -> Jira wins (pull)
 *     - Otherwise -> Sheet wins (push)
 *   Rows without a Key -> create in Jira (push)
 *   Jira issues not in the sheet -> append rows (pull)
 *
 * Conflict resolution uses last-write-wins based on timestamps.
 */

/* Entry point (called from menu) */

function syncCurrentSheet() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  // Resolve JQL
  const jqlResult = resolveSheetJql(sheet);
  if (jqlResult.error) {
    ui.alert('Sluice — Sync Failed', jqlResult.error, ui.ButtonSet.OK);
    return;
  }

  // Confirm intent before fetching
  const resp = ui.alert(
    'Sluice — Sync Sheet ↔ Jira',
    'JQL (' + jqlResult.source + '):\n' + jqlResult.jql +
    '\n\nThis will:\n' +
    '- Pull Jira changes into the sheet (for issues updated in Jira since last sync)\n' +
    '- Push sheet changes to Jira (for issues edited locally since last sync)\n' +
    '- Create new issues for rows without a Key\n' +
    '- Append new Jira issues not yet in the sheet\n\n' +
    'Conflict resolution: last-write-wins\n\nContinue?',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  // Fetch Jira issues first so we can compute total scope
  SpreadsheetApp.getActiveSpreadsheet().toast('Fetching issues from Jira…', 'Sluice', -1);

  const columns = getResolvedColumns();
  const cfg = getConfig();
  const jiraFields = buildFieldList_(columns);
  const searchResult = jiraSearch(jqlResult.jql, jiraFields, cfg.maxResults);

  SpreadsheetApp.getActiveSpreadsheet().toast('', 'Sluice', 1);

  if (searchResult.error) {
    ui.alert('Sluice — Sync Failed', 'Jira search failed: ' + searchResult.error, ui.ButtonSet.OK);
    return;
  }

  // Count actual Jira modifications (creates + pushes).
  // Pulls and appends only write to the sheet, so they don't count.
  // We resolve direction and compare data to get an accurate count.
  const headerMap = readHeaderMap(sheet);
  const lastRow = sheet.getLastRow();
  let potentialCreates = 0;  // rows with no Key but with Summary
  let potentialPushes = 0;   // rows where sheet wins AND data differs
  const jiraIssueMap = {};
  for (let j = 0; j < searchResult.issues.length; j++) {
    jiraIssueMap[searchResult.issues[j].key] = searchResult.issues[j];
  }

  if (headerMap['Key'] && lastRow > 1) {
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const keyIdx = headerMap['Key'] - 1;
    const sumIdx = headerMap['Summary'] ? headerMap['Summary'] - 1 : -1;
    const syncIdx = headerMap['Last Synced'] ? headerMap['Last Synced'] - 1 : -1;
    for (let i = 0; i < data.length; i++) {
      const k = String(data[i][keyIdx] || '').trim();
      const s = sumIdx >= 0 ? String(data[i][sumIdx] || '').trim() : '';
      if (!k && s) {
        potentialCreates++;
      } else if (k && jiraIssueMap[k]) {
        // Check direction: only count rows where sheet wins
        const lastSynced = syncIdx >= 0 ? normalizeCell_(data[i][syncIdx]) : '';
        const jiraUpdated = jiraIssueMap[k].fields.updated || '';
        const direction = resolveDirection_(lastSynced, jiraUpdated);
        if (direction === 'push') {
          // Check if the row actually differs from Jira
          const rowData = {};
          for (const header in headerMap) {
            const colIdx = headerMap[header] - 1;
            rowData[header] = colIdx < data[i].length ? normalizeCell_(data[i][colIdx]) : '';
          }
          const jiraRowData = extractRowFromIssue_(jiraIssueMap[k], columns, '');
          if (!rowDataMatchesJira_(rowData, jiraRowData, headerMap)) {
            potentialPushes++;
          }
        }
      }
    }
  }

  const maxJiraWrites = potentialCreates + potentialPushes;

  // Safety limits — only count potential Jira modifications
  if (maxJiraWrites > 50) {
    ui.alert(
      'Sluice — Sync Blocked',
      'This sync could modify up to ' + maxJiraWrites + ' issues in Jira ' +
      '(' + potentialCreates + ' creates + ' + potentialPushes + ' updates).\n\n' +
      'Limit: 50 Jira modifications per pass.\n\n' +
      'Narrow your filter or split the work across multiple passes.',
      ui.ButtonSet.OK
    );
    return;
  }

  if (maxJiraWrites > 20) {
    const typed = ui.prompt(
      'Sluice — Large Sync Warning',
      'This sync could modify up to ' + maxJiraWrites + ' issues in Jira ' +
      '(' + potentialCreates + ' creates + ' + potentialPushes + ' updates).\n\n' +
      'Type "Yes" to confirm:',
      ui.ButtonSet.OK_CANCEL
    );
    if (typed.getSelectedButton() !== ui.Button.OK ||
        typed.getResponseText().trim() !== 'Yes') {
      ui.alert('Sluice — Sync Cancelled', 'Sync was not confirmed.', ui.ButtonSet.OK);
      return;
    }
  }

  SpreadsheetApp.getActiveSpreadsheet().toast('Syncing with Jira…', 'Sluice', -1);

  const result = executeSync_withIssues_(sheet, searchResult.issues, columns, cfg);

  // Clean up rows for issues no longer in the filter.
  // Skipped when the search was truncated by maxResults, since we can't tell
  // "fell out of filter" apart from "not fetched this pass".
  let removed = 0;
  if (!searchResult.truncated) {
    const keySet = {};
    for (let i = 0; i < searchResult.issues.length; i++) {
      keySet[searchResult.issues[i].key] = true;
    }
    removed = removeStaleRows_(sheet, keySet);
  }

  SpreadsheetApp.getActiveSpreadsheet().toast('', 'Sluice', 1);

  let msg =
    'Pulled (Jira → Sheet): ' + result.pulled + '\n' +
    'Pushed (Sheet → Jira): ' + result.pushed + '\n' +
    'Created in Jira: ' + result.created + '\n' +
    'Appended from Jira: ' + result.appended + '\n' +
    'Removed (no longer in filter): ' + removed + '\n' +
    'Unchanged: ' + result.unchanged;

  if (searchResult.truncated) {
    msg += '\n\nNote: result set hit the maxResults cap — stale-row cleanup skipped. ' +
           'Raise maxResults or narrow the filter to enable cleanup.';
  }

  if (result.errors.length > 0) {
    msg += '\n\nErrors (' + result.errors.length + '):\n' +
      result.errors.slice(0, 10).join('\n');
    if (result.errors.length > 10) {
      msg += '\n… and ' + (result.errors.length - 10) + ' more';
    }
  }

  ui.alert('Sluice — Sync Complete', msg, ui.ButtonSet.OK);
}

/* Dry run — preview what a sync would do, without writing anything */

/**
 * Fetches issues and diffs against the sheet exactly like sync would, but
 * writes a per-field report to a "Sluice Dry Run" tab instead of pushing.
 *
 * Use to investigate unexpected modification counts (e.g. "why does it say
 * 215 rows would be pushed when I only edited 30?") or to preview changes
 * before committing them.
 */
function dryRunSync() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();

  if (sheet.getName() === 'Sluice Dry Run') {
    ui.alert('Sluice — Dry Run', 'Switch to the sheet you want to preview first.', ui.ButtonSet.OK);
    return;
  }

  const jqlResult = resolveSheetJql(sheet);
  if (jqlResult.error) {
    ui.alert('Sluice — Dry Run Failed', jqlResult.error, ui.ButtonSet.OK);
    return;
  }

  ss.toast('Fetching issues from Jira…', 'Sluice', -1);

  const columns = getResolvedColumns();
  const cfg = getConfig();
  const jiraFields = buildFieldList_(columns);
  const searchResult = jiraSearch(jqlResult.jql, jiraFields, cfg.maxResults);

  ss.toast('', 'Sluice', 1);

  if (searchResult.error) {
    ui.alert('Sluice — Dry Run Failed', 'Jira search failed: ' + searchResult.error, ui.ButtonSet.OK);
    return;
  }

  const report = buildDryRunReport_(sheet, searchResult.issues, columns, searchResult.truncated);

  writeDryRunSheet_(ss, sheet.getName(), jqlResult.jql, report, searchResult.truncated);

  ui.alert(
    'Sluice — Dry Run Complete',
    'Source sheet: ' + sheet.getName() + '\n\n' +
    'Would create: ' + report.summary.create + '\n' +
    'Would push:   ' + report.summary.pushIssues + ' issues (' +
      report.summary.pushFields + ' field changes)\n' +
    'Would pull:   ' + report.summary.pullIssues + ' issues (' +
      report.summary.pullFields + ' field changes)\n' +
    'Would append: ' + report.summary.append + '\n' +
    'Would remove: ' + report.summary.remove + '\n' +
    'Unchanged:    ' + report.summary.unchanged + '\n\n' +
    'See the "Sluice Dry Run" tab for per-field details. Nothing was written to Jira or to this sheet.',
    ui.ButtonSet.OK
  );
}

/**
 * Walk sheet rows and Jira issues, producing a list of action records.
 * Does not mutate anything.
 *
 * @return {Object} { rows: [...], summary: {...} }
 */
function buildDryRunReport_(sheet, issues, columns, truncated) {
  const jiraIssueMap = {};
  for (let i = 0; i < issues.length; i++) {
    jiraIssueMap[issues[i].key] = issues[i];
  }

  const headerMap = readHeaderMap(sheet);
  const lastRow = sheet.getLastRow();
  const numCols = sheet.getLastColumn();
  const allData = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, numCols).getValues() : [];

  const rows = [];
  const seenKeys = {};
  const summary = {
    create: 0,
    pushIssues: 0, pushFields: 0,
    pullIssues: 0, pullFields: 0,
    append: 0,
    remove: 0,
    unchanged: 0
  };

  for (let r = 0; r < allData.length; r++) {
    const rowNum = r + 2;
    const rowValues = allData[r];

    const rowData = {};
    for (const header in headerMap) {
      const colIdx = headerMap[header] - 1;
      rowData[header] = colIdx < rowValues.length ? normalizeCell_(rowValues[colIdx]) : '';
    }

    const key = rowData['Key'] || '';
    const summaryField = rowData['Summary'] || '';

    if (!key && !summaryField) continue;

    if (!key) {
      rows.push({ action: 'create', key: '(new, row ' + rowNum + ')', field: '(all)',
                  sheetValue: summaryField, jiraValue: '' });
      summary.create++;
      continue;
    }

    seenKeys[key] = true;
    const jiraIssue = jiraIssueMap[key];

    if (!jiraIssue) {
      // Either truncated (will be preserved) or stale (would be removed).
      if (!truncated) {
        rows.push({ action: 'remove', key: key, field: '(row)',
                    sheetValue: '(not in filter)', jiraValue: '' });
        summary.remove++;
      } else {
        summary.unchanged++;
      }
      continue;
    }

    const lastSynced = rowData['Last Synced'] || '';
    const jiraUpdated = jiraIssue.fields.updated || '';
    const direction = resolveDirection_(lastSynced, jiraUpdated);
    const jiraRowData = extractRowFromIssue_(jiraIssue, columns, '');

    const diffs = diffRow_(rowData, jiraRowData, headerMap, columns);

    if (diffs.length === 0) {
      summary.unchanged++;
      continue;
    }

    if (direction === 'pull') {
      summary.pullIssues++;
      summary.pullFields += diffs.length;
      for (let d = 0; d < diffs.length; d++) {
        rows.push({ action: 'pull', key: key, field: diffs[d].header,
                    sheetValue: diffs[d].sheetVal, jiraValue: diffs[d].jiraVal });
      }
    } else if (direction === 'push') {
      summary.pushIssues++;
      summary.pushFields += diffs.length;
      for (let d = 0; d < diffs.length; d++) {
        rows.push({ action: 'push', key: key, field: diffs[d].header,
                    sheetValue: diffs[d].sheetVal, jiraValue: diffs[d].jiraVal });
      }
    } else {
      summary.unchanged++;
    }
  }

  // Jira issues not in the sheet — would be appended
  for (const k in jiraIssueMap) {
    if (!seenKeys[k]) {
      const summaryVal = (jiraIssueMap[k].fields.summary || '');
      rows.push({ action: 'append', key: k, field: '(new row)',
                  sheetValue: '', jiraValue: summaryVal });
      summary.append++;
    }
  }

  return { rows: rows, summary: summary };
}

/**
 * Per-field diff between a sheet row and the equivalent Jira row data.
 * Skips read-only columns (same logic as rowDataMatchesJira_).
 *
 * @return {Array<{header,sheetVal,jiraVal}>}
 */
function diffRow_(sheetData, jiraData, headerMap, columns) {
  const skipHeaders = {};
  for (let i = 0; i < columns.length; i++) {
    if (columns[i].readOnly) skipHeaders[columns[i].header] = true;
  }

  const diffs = [];
  for (const header in headerMap) {
    if (skipHeaders[header]) continue;
    const sheetVal = (sheetData[header] || '').toString().trim();
    const jiraVal = (jiraData[header] || '').toString().trim();
    if (sheetVal !== jiraVal) {
      diffs.push({ header: header, sheetVal: sheetVal, jiraVal: jiraVal });
    }
  }
  return diffs;
}

/**
 * Write the dry run report to a dedicated "Sluice Dry Run" tab, overwriting
 * any prior contents. Never modifies the source sheet.
 */
function writeDryRunSheet_(ss, sourceName, jql, report, truncated) {
  const tabName = 'Sluice Dry Run';
  let out = ss.getSheetByName(tabName);
  if (out) {
    out.clear();
  } else {
    out = ss.insertSheet(tabName);
  }

  const header = ['Action', 'Key', 'Field', 'Sheet Value', 'Jira Value'];
  const preamble = [
    ['Sluice Dry Run — ' + new Date().toISOString()],
    ['Source sheet: ' + sourceName],
    ['JQL: ' + jql],
    [truncated ? 'NOTE: search was truncated — remove column may be incomplete.' : '']
  ];

  out.getRange(1, 1, preamble.length, 1).setValues(preamble);
  out.getRange(preamble.length + 2, 1, 1, header.length).setValues([header]);
  out.getRange(preamble.length + 2, 1, 1, header.length)
    .setFontWeight('bold').setBackground('#4a86c8').setFontColor('#ffffff');

  if (report.rows.length === 0) {
    out.getRange(preamble.length + 3, 1).setValue('(no changes detected)');
    return;
  }

  const data = report.rows.map(function (r) {
    return [r.action, r.key, r.field, r.sheetValue, r.jiraValue];
  });

  out.getRange(preamble.length + 3, 1, data.length, header.length).setValues(data);

  // Truncate long cells for readability
  out.setColumnWidth(1, 80);
  out.setColumnWidth(2, 100);
  out.setColumnWidth(3, 140);
  out.setColumnWidth(4, 320);
  out.setColumnWidth(5, 320);
  out.setFrozenRows(preamble.length + 2);
}

/* Core sync logic */

/**
 * @param {Sheet}  sheet
 * @param {Array}  issues  - pre-fetched Jira issue objects
 * @param {Array}  columns - resolved SLUICE_COLUMNS
 * @param {Object} cfg     - sluice config
 * @return {Object} { pulled, pushed, created, appended, unchanged, errors[] }
 */
function executeSync_withIssues_(sheet, issues, columns, cfg) {
  const stats = { pulled: 0, pushed: 0, created: 0, appended: 0, unchanged: 0, errors: [] };

  // Build a map of key -> Jira issue
  const jiraIssueMap = {};
  for (let i = 0; i < issues.length; i++) {
    jiraIssueMap[issues[i].key] = issues[i];
  }

  /* 2. Read all rows from the sheet */
  let headerMap = readHeaderMap(sheet);
  if (!headerMap['Key']) {
    writeHeaderRow(sheet);
    headerMap = readHeaderMap(sheet);
  }

  const lastRow = sheet.getLastRow();
  const numCols = sheet.getLastColumn();
  const allData = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, numCols).getValues()
    : [];

  // Build a map of key -> { rowNum, rowData } from the sheet
  const sheetKeySet = {}; // track all keys present in the sheet
  const userCache = {};
  const now = new Date().toISOString();

  /* 3. Process existing sheet rows */
  SpreadsheetApp.getActiveSpreadsheet().toast('Processing rows…', 'Sluice', -1);

  for (let r = 0; r < allData.length; r++) {
    const rowNum = r + 2;
    const rowValues = allData[r];

    // Read cell values by header, normalizing Date objects to strings
    const rowData = {};
    for (const header in headerMap) {
      const colIdx = headerMap[header] - 1;
      rowData[header] = colIdx < rowValues.length ? normalizeCell_(rowValues[colIdx]) : '';
    }

    let key = rowData['Key'] || '';
    const summary = rowData['Summary'] || '';

    // Skip completely empty rows
    if (!key && !summary) {
      stats.unchanged++;
      continue;
    }

    // --- Case A: Row has no Key -> create new issue in Jira ---
    if (!key) {
      if (!summary) {
        stats.unchanged++;
        continue;
      }

      try {
        const createResult = createIssue_(rowData, columns, cfg, userCache);
        if (createResult.error) {
          stats.errors.push('Row ' + rowNum + ': ' + createResult.error);
        } else {
          stats.created++;
          key = createResult.key;
          if (headerMap['Key']) {
            setKeyLink_(sheet, rowNum, headerMap['Key'], key);
          }
          // Post-create: links and status
          handleLinks_(key, rowData, stats.errors, rowNum);
          if (rowData['Status']) {
            const createType = rowData['Type'] || 'Task';
            handleStatusTransition_(key, rowData['Status'], createType, stats.errors, rowNum);
          }
          // Stamp Last Synced AFTER transitions so it's newer than Jira's updated
          if (headerMap['Last Synced']) {
            sheet.getRange(rowNum, headerMap['Last Synced']).setValue(new Date().toISOString());
          }
        }
      } catch (e) {
        stats.errors.push('Row ' + rowNum + ': ' + e.toString());
      }
      continue;
    }

    // --- Case B: Row has a Key ---
    sheetKeySet[key] = true;
    const jiraIssue = jiraIssueMap[key];

    if (!jiraIssue) {
      // Issue exists in sheet but not in Jira search results.
      // It may have moved out of the filter scope or been deleted.
      // Do NOT push updates - this could modify issues outside the
      // user's intended scope. Just skip it.
      stats.unchanged++;
      continue;
    }

    // Issue exists in both sheet and Jira - decide direction
    const lastSynced = rowData['Last Synced'] || '';
    const jiraUpdated = jiraIssue.fields.updated || '';

    const direction = resolveDirection_(lastSynced, jiraUpdated);

    if (direction === 'pull') {
      // Jira wins - overwrite sheet row with Jira data
      const jiraRowData = extractRowFromIssue_(jiraIssue, columns, now);
      writeRowToSheet_(sheet, rowNum, headerMap, columns, jiraRowData);
      stats.pulled++;

    } else if (direction === 'push') {
      // Sheet wins - but only push if the row actually differs from Jira
      const jiraRowData = extractRowFromIssue_(jiraIssue, columns, '');
      if (rowDataMatchesJira_(rowData, jiraRowData, headerMap)) {
        // No differences - skip the push, just refresh timestamp
        if (headerMap['Last Synced']) {
          sheet.getRange(rowNum, headerMap['Last Synced']).setValue(now);
        }
        stats.unchanged++;
      } else {
        try {
          const updateResult2 = updateIssue_(key, rowData, columns, cfg, userCache);
          if (updateResult2.error) {
            stats.errors.push('Row ' + rowNum + ' (' + key + '): ' + updateResult2.error);
          } else {
            stats.pushed++;
            handleLinks_(key, rowData, stats.errors, rowNum);
            if (rowData['Status']) {
              const pushType = rowData['Type'] || (jiraIssue.fields.issuetype ? jiraIssue.fields.issuetype.name : 'Task');
              handleStatusTransition_(key, rowData['Status'], pushType, stats.errors, rowNum);
            }
            // Stamp Last Synced AFTER transitions so it's newer than Jira's updated
            if (headerMap['Last Synced']) {
              sheet.getRange(rowNum, headerMap['Last Synced']).setValue(new Date().toISOString());
            }
          }
        } catch (e) {
          stats.errors.push('Row ' + rowNum + ' (' + key + '): ' + e.toString());
        }
      }

    } else {
      // No changes detected - still refresh Last Synced
      if (headerMap['Last Synced']) {
        sheet.getRange(rowNum, headerMap['Last Synced']).setValue(now);
      }
      stats.unchanged++;
    }
  }

  /* 4. Append Jira issues not in the sheet */
  const appendRows = [];
  for (const jiraKey in jiraIssueMap) {
    if (!sheetKeySet[jiraKey]) {
      const newRowData = extractRowFromIssue_(jiraIssueMap[jiraKey], columns, now);
      appendRows.push(newRowData);
      stats.appended++;
    }
  }

  if (appendRows.length > 0) {
    const startRow = sheet.getLastRow() + 1;
    const runs = sluiceColumnRuns_(headerMap, columns);

    for (let r = 0; r < runs.length; r++) {
      const run = runs[r];
      const width = run.end - run.start + 1;
      const batchData = [];
      for (let a = 0; a < appendRows.length; a++) {
        const rowArr = new Array(width);
        for (let c = 0; c < width; c++) rowArr[c] = '';
        for (let ci = 0; ci < columns.length; ci++) {
          const hdr = columns[ci].header;
          const colIdx = headerMap[hdr];
          if (!colIdx || colIdx < run.start || colIdx > run.end) continue;
          const val = appendRows[a][hdr];
          rowArr[colIdx - run.start] = (val === undefined ? '' : val);
        }
        batchData.push(rowArr);
      }
      sheet.getRange(startRow, run.start, batchData.length, width).setValues(batchData);
    }

    // Set Key column links on appended rows
    if (headerMap['Key']) {
      for (let k = 0; k < appendRows.length; k++) {
        const keyVal = appendRows[k]['Key'];
        if (keyVal) {
          setKeyLink_(sheet, startRow + k, headerMap['Key'], keyVal);
        }
      }
    }
  }

  return stats;
}

/* Helpers */

/**
 * Normalize a cell value to a stable string for comparison.
 *
 * Google Sheets auto-parses date-formatted strings (e.g. "2025-01-15") into
 * JavaScript Date objects.  String(dateObj) produces a long format like
 * "Wed Jan 15 2025 00:00:00 GMT-0800" which won't match Jira's ISO strings.
 *
 * This converts Date objects to ISO date (YYYY-MM-DD) for date-only values
 * or ISO timestamp for datetime values, matching the formats produced by
 * extractRowFromIssue_().
 */
function normalizeCell_(val) {
  if (val == null) return '';
  if (val instanceof Date) {
    // If the time portion is midnight, treat as date-only (YYYY-MM-DD)
    if (val.getHours() === 0 && val.getMinutes() === 0 && val.getSeconds() === 0) {
      const y = val.getFullYear();
      const m = String(val.getMonth() + 1).padStart(2, '0');
      const d = String(val.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + d;
    }
    return val.toISOString();
  }
  return String(val).trim();
}

/* Conflict resolution */

/**
 * Determine sync direction for a row based on timestamps.
 *
 * Last-write-wins logic:
 *   - If the row has never been synced (no Last Synced) -> pull from Jira
 *     (treat Jira as source of truth for first sync)
 *   - If Jira's "updated" is after the row's "Last Synced" -> Jira was
 *     modified since we last synced -> pull (Jira wins)
 *   - If Jira's "updated" is at or before "Last Synced" -> Jira hasn't
 *     changed; any differences in the sheet are local edits -> push
 *
 * @param {string} lastSynced  - ISO timestamp from the sheet's Last Synced column
 * @param {string} jiraUpdated - ISO timestamp from the Jira issue's "updated" field
 * @return {string} 'pull', 'push', or 'unchanged'
 */
function resolveDirection_(lastSynced, jiraUpdated) {
  // Never synced before -> pull from Jira
  if (!lastSynced) return 'pull';

  // No Jira updated timestamp (shouldn't happen) -> push
  if (!jiraUpdated) return 'push';

  const syncTime = new Date(lastSynced).getTime();
  const jiraTime = new Date(jiraUpdated).getTime();

  if (isNaN(syncTime)) return 'pull';
  if (isNaN(jiraTime)) return 'push';

  // Jira was modified after last sync -> Jira wins
  if (jiraTime > syncTime) return 'pull';

  // Jira hasn't changed since last sync -> sheet wins (push local edits)
  // The caller will compare field values before actually pushing.
  return 'push';
}

/* Row comparison */

/**
 * Compare sheet row data against Jira row data to detect actual changes.
 * Skips all read-only columns (they're populated from Jira and never pushed,
 * so differences are irrelevant for deciding whether to push).
 *
 * @param {Object} sheetData  - header -> value from sheet
 * @param {Object} jiraData   - header -> value from extractRowFromIssue_
 * @param {Object} headerMap  - header -> column index (only headers present in sheet)
 * @return {boolean} true if the data matches (no push needed)
 */
function rowDataMatchesJira_(sheetData, jiraData, headerMap) {
  // Build skip set from read-only columns so it stays in sync with SheetMeta
  const skipHeaders = {};
  const cols = getResolvedColumns();
  for (let i = 0; i < cols.length; i++) {
    if (cols[i].readOnly) skipHeaders[cols[i].header] = true;
  }

  for (const header in headerMap) {
    if (skipHeaders[header]) continue;

    const sheetVal = (sheetData[header] || '').toString().trim();
    const jiraVal = (jiraData[header] || '').toString().trim();

    if (sheetVal !== jiraVal) return false;
  }

  return true;
}

/**
 * Sluice - Pull (Jira -> Sheet)
 *
 * Fetches issues matching the sheet's JQL and writes/updates rows.
 * Existing rows (matched by Key) are updated in place.
 * New issues from Jira are appended.
 * The "Last Synced" column is stamped on every touched row.
 */

/* Entry point (called from menu) */

function pullFromJira() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  // Resolve JQL
  const jqlResult = resolveSheetJql(sheet);
  if (jqlResult.error) {
    ui.alert('Sluice — Pull Failed', jqlResult.error, ui.ButtonSet.OK);
    return;
  }

  // Confirm with user
  const resp = ui.alert(
    'Sluice — Pull from Jira',
    'JQL (' + jqlResult.source + '):\n' + jqlResult.jql +
    '\n\nThis will update the current sheet with data from Jira.\nContinue?',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  // Fetch issues first to get the count
  SpreadsheetApp.getActiveSpreadsheet().toast('Fetching issues from Jira…', 'Sluice', -1);

  const columns = getResolvedColumns();
  const jiraFields = buildFieldList_(columns);
  const cfg = getConfig();
  const searchResult = jiraSearch(jqlResult.jql, jiraFields, cfg.maxResults);

  SpreadsheetApp.getActiveSpreadsheet().toast('', 'Sluice', 1);

  if (searchResult.error) {
    ui.alert('Sluice — Pull Failed', searchResult.error, ui.ButtonSet.OK);
    return;
  }

  const issueCount = searchResult.issues.length;
  if (issueCount === 0) {
    ui.alert('Sluice — Pull Complete', 'No issues found matching the filter.', ui.ButtonSet.OK);
    return;
  }

  // Confirm issue count (pull only writes to the sheet, so no hard limit —
  // maxResults already caps the query)
  const pullResp = ui.alert(
    'Sluice — Pull from Jira',
    'Found ' + issueCount + ' issues.\n\nWrite them to the sheet?',
    ui.ButtonSet.YES_NO
  );
  if (pullResp !== ui.Button.YES) return;

  SpreadsheetApp.getActiveSpreadsheet().toast('Writing to sheet…', 'Sluice', -1);

  const result = executePull_withIssues_(sheet, searchResult.issues, columns);

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

  let msg = 'Updated: ' + result.updated + '  |  Added: ' + result.added +
            '  |  Removed: ' + removed + '  |  Total: ' + result.total + ' issues';
  if (searchResult.truncated) {
    msg += '\n\nNote: result set hit the maxResults cap — stale-row cleanup skipped. ' +
           'Raise maxResults or narrow the filter to enable cleanup.';
  }
  ui.alert('Sluice — Pull Complete', msg, ui.ButtonSet.OK);
}

/**
 * Delete sheet rows whose Key is not present in the current Jira result set.
 * Preserves rows with no Key (pending creates).
 *
 * Callers must skip this when the Jira search was truncated — see
 * jiraSearch's truncated flag.
 *
 * @param {Sheet}  sheet
 * @param {Object} jiraKeySet - map of issue key -> truthy
 * @return {number} rows removed
 */
function removeStaleRows_(sheet, jiraKeySet) {
  const headerMap = readHeaderMap(sheet);
  const keyCol = headerMap['Key'];
  if (!keyCol) return 0;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const keyValues = sheet.getRange(2, keyCol, lastRow - 1, 1).getValues();
  const rowsToDelete = [];
  for (let r = 0; r < keyValues.length; r++) {
    const k = String(keyValues[r][0] || '').trim();
    if (k && !jiraKeySet[k]) {
      rowsToDelete.push(r + 2); // 1-indexed sheet row
    }
  }

  // Delete bottom-up so earlier indices stay valid
  for (let i = rowsToDelete.length - 1; i >= 0; i--) {
    sheet.deleteRow(rowsToDelete[i]);
  }

  return rowsToDelete.length;
}

/* Core pull logic */

/**
 * Write pre-fetched Jira issues into the sheet.
 *
 * @param {Sheet}  sheet   - target sheet
 * @param {Array}  issues  - Jira issue objects from jiraSearch
 * @param {Array}  columns - resolved SLUICE_COLUMNS
 * @return {Object} { updated, added, total }
 */
function executePull_withIssues_(sheet, issues, columns) {
  // Ensure header row exists
  let headerMap = readHeaderMap(sheet);
  if (!headerMap['Key']) {
    writeHeaderRow(sheet);
    headerMap = readHeaderMap(sheet);
  }

  // Build a map of existing Key -> row number from the sheet
  const keyCol = headerMap['Key'];
  const existingKeys = {};
  if (sheet.getLastRow() > 1) {
    const keyValues = sheet.getRange(2, keyCol, sheet.getLastRow() - 1, 1).getValues();
    for (let r = 0; r < keyValues.length; r++) {
      const k = (keyValues[r][0] || '').toString().trim();
      if (k) {
        existingKeys[k] = r + 2; // row number (1-indexed, skip header)
      }
    }
  }

  let updated = 0;
  let added = 0;
  const now = new Date().toISOString();

  // Separate issues into updates vs appends for batch writing
  const updateRows = [];  // { rowNum, data }
  const appendRows = [];  // { data }

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const key = issue.key;
    const rowData = extractRowFromIssue_(issue, columns, now);

    if (existingKeys[key]) {
      updateRows.push({ rowNum: existingKeys[key], data: rowData });
      updated++;
    } else {
      appendRows.push({ data: rowData });
      added++;
    }
  }

  // Write updates (in-place rows)
  for (let u = 0; u < updateRows.length; u++) {
    writeRowToSheet_(sheet, updateRows[u].rowNum, headerMap, columns, updateRows[u].data);
  }

  // Batch-write appended rows, one contiguous run of Sluice columns at a time
  // so user-added columns (e.g. formula columns) are left untouched.
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
          const header = columns[ci].header;
          const colIdx = headerMap[header];
          if (!colIdx || colIdx < run.start || colIdx > run.end) continue;
          const val = appendRows[a].data[header];
          rowArr[colIdx - run.start] = (val === undefined ? '' : val);
        }
        batchData.push(rowArr);
      }
      sheet.getRange(startRow, run.start, batchData.length, width).setValues(batchData);
    }

    // Set Key column links on appended rows
    if (headerMap['Key']) {
      for (let k = 0; k < appendRows.length; k++) {
        const keyVal = appendRows[k].data['Key'];
        if (keyVal) {
          setKeyLink_(sheet, startRow + k, headerMap['Key'], keyVal);
        }
      }
    }
  }

  return { updated: updated, added: added, total: issues.length };
}

/* Field list builder */

/**
 * Build the list of Jira field IDs to request in the search API.
 */
function buildFieldList_(columns) {
  const fields = [];
  const seen = {};

  for (let i = 0; i < columns.length; i++) {
    const jf = columns[i].jiraField;
    if (!jf || jf === '_sluice_sync' || jf.indexOf('_custom') === 0) continue;

    // Issue links and key are not "fields" in the Jira search sense
    if (jf === 'key') continue;

    // Link columns: we request 'issuelinks'
    if (jf.indexOf('link:') === 0) {
      if (!seen['issuelinks']) {
        fields.push('issuelinks');
        seen['issuelinks'] = true;
      }
      continue;
    }

    if (!seen[jf]) {
      fields.push(jf);
      seen[jf] = true;
    }
  }

  // Always request updated timestamp for conflict detection
  if (!seen['updated']) {
    fields.push('updated');
  }

  return fields;
}

/* Issue -> row data extraction */

/**
 * Extract a flat row array from a Jira issue, aligned with the column defs.
 *
 * @param {Object} issue    - Jira issue object from search API
 * @param {Array}  columns  - resolved SLUICE_COLUMNS
 * @param {string} syncTime - ISO timestamp for Last Synced
 * @return {Object} map of header -> cell value
 */
function extractRowFromIssue_(issue, columns, syncTime) {
  const fields = issue.fields || {};
  const row = {};

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const jf = col.jiraField;
    let val = '';

    switch (jf) {
      case 'key':
        val = issue.key || '';
        break;

      case 'issuetype':
        val = fields.issuetype ? fields.issuetype.name : '';
        break;

      case 'priority':
        val = fields.priority ? fields.priority.name : '';
        break;

      case 'summary':
        val = fields.summary || '';
        break;

      case 'description':
        // Jira API v3 returns description as ADF (Atlassian Document Format).
        // Convert to Markdown for display in the sheet.
        val = adfToMarkdown_(fields.description);
        break;

      case 'environment':
        // Jira API v3 returns environment as ADF (like description)
        val = adfToMarkdown_(fields.environment);
        break;

      case 'assignee':
        val = extractUser_(fields.assignee);
        break;

      case 'reporter':
        val = extractUser_(fields.reporter);
        break;

      case 'status':
        val = fields.status ? fields.status.name : '';
        break;

      case 'resolution':
        val = fields.resolution ? fields.resolution.name : '';
        break;

      case 'created':
        val = fields.created || '';
        break;

      case 'duedate':
        val = fields.duedate || '';
        break;

      case 'parent':
        val = fields.parent ? fields.parent.key : '';
        break;

      case 'subtasks':
        val = (fields.subtasks || []).map(function (s) { return s.key; }).join(', ');
        break;

      case 'components':
        val = (fields.components || []).map(function (c) { return c.name; }).join(', ');
        break;

      case 'fixVersions':
        val = (fields.fixVersions || []).map(function (v) { return v.name; }).join(', ');
        break;

      case 'labels':
        val = (fields.labels || []).join(', ');
        break;

      case '_sluice_sync':
        val = syncTime;
        break;

      case '_custom_':
      case '_custom_wa_':
      case '_custom_sprint_':
      case '_custom_sp_':
      case '_custom_bug_steps_':
      case '_custom_bug_expected_':
      case '_custom_bug_actual_':
      case '_custom_bug_outcomes_':
        // Unmapped custom field - leave blank
        val = '';
        break;

      default:
        if (jf.indexOf('link:') === 0) {
          val = extractLinks_(fields.issuelinks, jf.substring(5));
        } else if (jf.indexOf('customfield_') === 0) {
          val = extractCustomField_(fields[jf]);
        } else {
          val = fields[jf] != null ? String(fields[jf]) : '';
        }
        break;
    }

    row[col.header] = val;
  }

  return row;
}

/**
 * Extract display name or email from a Jira user object.
 */
function extractUser_(user) {
  if (!user) return '';
  return user.displayName || user.emailAddress || user.accountId || '';
}

/**
 * Extract linked issue keys for a given link type name.
 *
 * Jira issue links have a type with inward/outward names.
 * For "Blocks": outwardIssue is "blocks", inwardIssue is "is blocked by"
 * For "Depends": this maps to a link type - we check both directions.
 *
 * @param {Array}  links    - issue.fields.issuelinks array
 * @param {string} linkType - e.g. "Blocks" or "Depends"
 * @return {string} comma-separated keys
 */
function extractLinks_(links, linkType) {
  if (!links || !links.length) return '';

  const keys = [];
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const typeName = link.type ? link.type.name : '';

    if (linkType === 'Blocks') {
      // Outward: this issue blocks the linked issue
      if (typeName === 'Blocks' && link.outwardIssue) {
        keys.push(link.outwardIssue.key);
      }
    } else if (linkType === 'Depends') {
      // Inward: this issue depends on (is blocked by) the linked issue
      if (typeName === 'Blocks' && link.inwardIssue) {
        keys.push(link.inwardIssue.key);
      }
      // Also check for explicit "Dependency" link type
      if (typeName === 'Dependency' || typeName === 'Depends') {
        if (link.outwardIssue) keys.push(link.outwardIssue.key);
        if (link.inwardIssue) keys.push(link.inwardIssue.key);
      }
    }
  }

  return keys.join(', ');
}

/**
 * Extract a readable value from an arbitrary custom field.
 * Custom fields can be strings, numbers, objects with 'value' or 'name', or arrays.
 */
function extractCustomField_(fieldValue) {
  if (fieldValue == null) return '';
  if (typeof fieldValue === 'string' || typeof fieldValue === 'number') {
    return String(fieldValue);
  }
  if (Array.isArray(fieldValue)) {
    return fieldValue.map(function (v) {
      if (typeof v === 'string') return v;
      return v.value || v.name || String(v);
    }).join(', ');
  }
  if (typeof fieldValue === 'object') {
    // ADF document (textarea custom fields in Jira v3)
    if (fieldValue.type === 'doc' && fieldValue.content) {
      return adfToMarkdown_(fieldValue);
    }
    return fieldValue.value || fieldValue.name || fieldValue.displayName || JSON.stringify(fieldValue);
  }
  return String(fieldValue);
}

/* Write row data to sheet */

/**
 * Group Sluice-managed columns into contiguous 1-based column runs.
 * Used by all sheet writers to skip user-added columns (e.g. a "Days in
 * Status" formula column). Writes that span non-Sluice columns would
 * overwrite user content with blanks.
 *
 * @param {Object} headerMap - header -> 1-based column index
 * @param {Array}  columns   - resolved SLUICE_COLUMNS
 * @return {Array<{start:number, end:number}>}
 */
function sluiceColumnRuns_(headerMap, columns) {
  const idxs = [];
  for (let i = 0; i < columns.length; i++) {
    const idx = headerMap[columns[i].header];
    if (idx) idxs.push(idx);
  }
  idxs.sort(function (a, b) { return a - b; });
  if (idxs.length === 0) return [];

  const runs = [];
  let start = idxs[0], end = start;
  for (let i = 1; i < idxs.length; i++) {
    if (idxs[i] === end + 1) {
      end = idxs[i];
    } else {
      runs.push({ start: start, end: end });
      start = idxs[i];
      end = start;
    }
  }
  runs.push({ start: start, end: end });
  return runs;
}

/**
 * Write a row-data object into the sheet at the given row number.
 * Writes only Sluice-managed columns, preserving any user-added columns
 * (including formula columns) that sit between or after them.
 *
 * @param {Sheet}  sheet     - target sheet
 * @param {number} rowNum    - 1-based row number
 * @param {Object} headerMap - header name -> column index (1-based)
 * @param {Array}  columns   - resolved SLUICE_COLUMNS
 * @param {Object} rowData   - header name -> cell value
 */
function writeRowToSheet_(sheet, rowNum, headerMap, columns, rowData) {
  const runs = sluiceColumnRuns_(headerMap, columns);
  if (runs.length === 0) return;

  // Map Sluice column index -> value for this row
  const cellValues = {};
  for (let i = 0; i < columns.length; i++) {
    const header = columns[i].header;
    const colIdx = headerMap[header];
    if (!colIdx) continue;
    let value = rowData[header];
    if (value === undefined) value = '';
    cellValues[colIdx] = value;
  }

  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    const width = run.end - run.start + 1;
    const arr = new Array(width);
    for (let c = 0; c < width; c++) {
      arr[c] = (cellValues[run.start + c] !== undefined ? cellValues[run.start + c] : '');
    }
    sheet.getRange(rowNum, run.start, 1, width).setValues([arr]);
  }

  // Key column: overwrite with a clickable hyperlink (requires separate call)
  const keyColIdx = headerMap['Key'];
  if (rowData['Key'] && keyColIdx) {
    setKeyLink_(sheet, rowNum, keyColIdx, rowData['Key']);
  }
}

/**
 * Write an issue key as a clickable hyperlink to the Jira issue.
 */
function setKeyLink_(sheet, rowNum, colIdx, key) {
  const cfg = getConfig();
  const url = cfg.jiraBaseUrl + '/browse/' + key;
  const richText = SpreadsheetApp.newRichTextValue()
    .setText(key)
    .setLinkUrl(url)
    .build();
  sheet.getRange(rowNum, colIdx).setRichTextValue(richText);
}

/* ADF <-> Markdown conversion */
//
// Jira API v3 uses Atlassian Document Format (ADF) for rich-text fields
// (description, comments, etc.).  Sluice stores these as Markdown in the
// sheet and converts in both directions:
//
//   Pull:  ADF -> Markdown  (adfToMarkdown_)
//   Push:  Markdown -> ADF  (markdownToAdf_)
//
// Supported formatting:
//   Headings (# through ######), bold (**), italic (*), strikethrough (~~),
//   inline code (`), code blocks (```), links ([text](url)), bullet lists (-),
//   ordered lists (1.), blockquotes (>), horizontal rules (---).
//

/* ADF -> Markdown (Pull) */

/**
 * Convert a Jira ADF document to Markdown.
 *
 * @param {Object|null} adf - ADF document node
 * @return {string} Markdown text
 */
function adfToMarkdown_(adf) {
  if (!adf) return '';
  if (typeof adf === 'string') return adf;
  if (adf.type === 'doc') {
    return adfBlocksToMarkdown_(adf.content || []).replace(/\n{3,}/g, '\n\n').trim();
  }
  return adfNodeToMarkdown_(adf, '');
}

/**
 * Convert a list of block-level ADF nodes to Markdown, joining with
 * blank lines between blocks.
 */
function adfBlocksToMarkdown_(nodes) {
  if (!nodes || !nodes.length) return '';
  const parts = [];
  for (let i = 0; i < nodes.length; i++) {
    parts.push(adfNodeToMarkdown_(nodes[i], ''));
  }
  return parts.join('\n\n');
}

/**
 * Convert a single ADF node (and its children) to Markdown.
 *
 * @param {Object} node   - ADF node
 * @param {string} prefix - line prefix for nested contexts (e.g. "> " for blockquotes)
 * @return {string}
 */
function adfNodeToMarkdown_(node, prefix) {
  if (!node) return '';

  switch (node.type) {

    case 'text':
      return adfTextWithMarks_(node);

    case 'hardBreak':
      return '\n';

    case 'paragraph':
      return prefix + adfInlineContent_(node.content);

    case 'heading':
      const level = node.attrs ? node.attrs.level : 1;
      let hashes = '';
      for (let h = 0; h < level; h++) hashes += '#';
      return prefix + hashes + ' ' + adfInlineContent_(node.content);

    case 'bulletList':
      return adfListToMarkdown_(node.content, '- ', prefix);

    case 'orderedList':
      return adfOrderedListToMarkdown_(node.content, prefix);

    case 'listItem':
      // Rendered by the list parent; fallback if encountered standalone
      return prefix + adfInlineContent_(node.content);

    case 'blockquote':
      return adfBlockquoteToMarkdown_(node.content, prefix);

    case 'codeBlock':
      const lang = (node.attrs && node.attrs.language) ? node.attrs.language : '';
      const code = adfPlainText_(node.content);
      return prefix + '```' + lang + '\n' + code + '\n' + prefix + '```';

    case 'rule':
      return prefix + '---';

    case 'mediaSingle':
    case 'media':
      // Media (images, attachments) can't be represented in a cell
      return prefix + '[attachment]';

    case 'panel':
      // Panels: render content with a "> " prefix
      return adfBlockquoteToMarkdown_(node.content, prefix);

    case 'table':
      return adfTableToMarkdown_(node, prefix);

    default:
      // Unknown node types: extract whatever text content exists
      if (node.content) {
        return adfBlocksToMarkdown_(node.content);
      }
      return '';
  }
}

/**
 * Convert ADF inline content (an array of text/inline nodes) to Markdown.
 */
function adfInlineContent_(nodes) {
  if (!nodes || !nodes.length) return '';
  const parts = [];
  for (let i = 0; i < nodes.length; i++) {
    parts.push(adfNodeToMarkdown_(nodes[i], ''));
  }
  return parts.join('');
}

/**
 * Apply Markdown formatting based on ADF text marks (bold, italic, etc.).
 */
function adfTextWithMarks_(node) {
  let text = node.text || '';
  if (!node.marks || !node.marks.length) return text;

  for (let i = 0; i < node.marks.length; i++) {
    const mark = node.marks[i];
    switch (mark.type) {
      case 'strong':
        text = '**' + text + '**';
        break;
      case 'em':
        text = '*' + text + '*';
        break;
      case 'strike':
        text = '~~' + text + '~~';
        break;
      case 'code':
        text = '`' + text + '`';
        break;
      case 'link':
        const href = mark.attrs ? mark.attrs.href : '';
        if (href) text = '[' + text + '](' + href + ')';
        break;
      // superscript, subscript, underline - no standard Markdown equivalent
    }
  }
  return text;
}

/**
 * Convert a bullet list's listItem nodes to Markdown.
 */
function adfListToMarkdown_(items, bullet, prefix) {
  if (!items || !items.length) return '';
  const lines = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const content = item.content || [];
    let firstBlock = true;
    for (let j = 0; j < content.length; j++) {
      const child = content[j];
      if (child.type === 'bulletList') {
        lines.push(adfListToMarkdown_(child.content, '- ', prefix + '  '));
      } else if (child.type === 'orderedList') {
        lines.push(adfOrderedListToMarkdown_(child.content, prefix + '  '));
      } else if (firstBlock) {
        lines.push(prefix + bullet + adfInlineContent_(child.content));
        firstBlock = false;
      } else {
        lines.push(prefix + '  ' + adfInlineContent_(child.content));
      }
    }
  }
  return lines.join('\n');
}

/**
 * Convert an ordered list's listItem nodes to Markdown.
 */
function adfOrderedListToMarkdown_(items, prefix) {
  if (!items || !items.length) return '';
  const lines = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const content = item.content || [];
    let firstBlock = true;
    const num = (i + 1) + '. ';
    for (let j = 0; j < content.length; j++) {
      const child = content[j];
      if (child.type === 'bulletList') {
        lines.push(adfListToMarkdown_(child.content, '- ', prefix + '   '));
      } else if (child.type === 'orderedList') {
        lines.push(adfOrderedListToMarkdown_(child.content, prefix + '   '));
      } else if (firstBlock) {
        lines.push(prefix + num + adfInlineContent_(child.content));
        firstBlock = false;
      } else {
        lines.push(prefix + '   ' + adfInlineContent_(child.content));
      }
    }
  }
  return lines.join('\n');
}

/**
 * Convert blockquote content to Markdown with "> " prefix.
 */
function adfBlockquoteToMarkdown_(nodes, prefix) {
  if (!nodes || !nodes.length) return '';
  const inner = [];
  for (let i = 0; i < nodes.length; i++) {
    inner.push(adfNodeToMarkdown_(nodes[i], prefix + '> '));
  }
  return inner.join('\n');
}

/**
 * Convert an ADF table to a Markdown table.
 */
function adfTableToMarkdown_(tableNode, prefix) {
  if (!tableNode.content || !tableNode.content.length) return '';
  const rows = [];
  for (let r = 0; r < tableNode.content.length; r++) {
    const row = tableNode.content[r];
    if (!row.content) continue;
    const cells = [];
    for (let c = 0; c < row.content.length; c++) {
      const cell = row.content[c];
      cells.push(adfInlineContent_(cell.content && cell.content[0] ? cell.content[0].content : []));
    }
    rows.push(prefix + '| ' + cells.join(' | ') + ' |');
    // Add separator after header row
    if (r === 0) {
      const sep = [];
      for (let s = 0; s < cells.length; s++) sep.push('---');
      rows.push(prefix + '| ' + sep.join(' | ') + ' |');
    }
  }
  return rows.join('\n');
}

/**
 * Extract plain text from ADF nodes (used for code blocks where marks
 * should not be applied).
 */
function adfPlainText_(nodes) {
  if (!nodes || !nodes.length) return '';
  const parts = [];
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].type === 'text') {
      parts.push(nodes[i].text || '');
    } else if (nodes[i].type === 'hardBreak') {
      parts.push('\n');
    }
  }
  return parts.join('');
}

/* Markdown -> ADF (Push) */

/**
 * Convert Markdown text to a Jira ADF document.
 *
 * @param {string} markdown - Markdown text from the sheet cell
 * @return {Object} ADF document
 */
function markdownToAdf_(markdown) {
  if (!markdown) {
    return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [] }] };
  }

  const lines = markdown.split('\n');
  const content = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // --- Code block (```) ---
    const codeMatch = line.match(/^```(.*)$/);
    if (codeMatch) {
      const lang = codeMatch[1].trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const codeNode = { type: 'codeBlock', content: [] };
      if (lang) codeNode.attrs = { language: lang };
      const codeText = codeLines.join('\n');
      if (codeText) {
        codeNode.content.push({ type: 'text', text: codeText });
      }
      content.push(codeNode);
      continue;
    }

    // --- Horizontal rule ---
    if (/^-{3,}\s*$/.test(line) || /^\*{3,}\s*$/.test(line)) {
      content.push({ type: 'rule' });
      i++;
      continue;
    }

    // --- Heading (# through ######) ---
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      content.push({
        type: 'heading',
        attrs: { level: headingMatch[1].length },
        content: parseInlineMarkdown_(headingMatch[2])
      });
      i++;
      continue;
    }

    // --- Blockquote (> ) ---
    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      // Recursively parse the blockquote content as Markdown
      const innerAdf = markdownToAdf_(quoteLines.join('\n'));
      content.push({
        type: 'blockquote',
        content: innerAdf.content
      });
      continue;
    }

    // --- Unordered list (- or * ) ---
    if (/^[\-\*]\s+/.test(line)) {
      const listResult = parseMarkdownList_(lines, i, 'bullet', 0);
      content.push(listResult.node);
      i = listResult.nextIndex;
      continue;
    }

    // --- Ordered list (1. ) ---
    if (/^\d+\.\s+/.test(line)) {
      const ordResult = parseMarkdownList_(lines, i, 'ordered', 0);
      content.push(ordResult.node);
      i = ordResult.nextIndex;
      continue;
    }

    // --- Empty line ---
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // --- Paragraph (default) ---
    // Collect consecutive non-special lines as one paragraph
    const paraLines = [];
    while (i < lines.length &&
           !/^\s*$/.test(lines[i]) &&
           !/^#{1,6}\s/.test(lines[i]) &&
           !/^```/.test(lines[i]) &&
           !/^>\s?/.test(lines[i]) &&
           !/^[\-\*]\s+/.test(lines[i]) &&
           !/^\d+\.\s+/.test(lines[i]) &&
           !/^-{3,}\s*$/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    content.push({
      type: 'paragraph',
      content: parseInlineMarkdown_(paraLines.join('\n'))
    });
  }

  if (content.length === 0) {
    content.push({ type: 'paragraph', content: [] });
  }

  return { type: 'doc', version: 1, content: content };
}

/**
 * Parse a Markdown list (bullet or ordered) starting at the given line index.
 * Handles nested lists via indentation.
 *
 * @param {string[]} lines     - all lines
 * @param {number}   startIdx  - starting line index
 * @param {string}   listType  - 'bullet' or 'ordered'
 * @param {number}   indent    - current indentation level (in spaces)
 * @return {Object} { node: ADF list node, nextIndex: number }
 */
function parseMarkdownList_(lines, startIdx, listType, indent) {
  const items = [];
  let i = startIdx;
  const bulletPattern = /^(\s*)([\-\*])\s+(.*)$/;
  const orderedPattern = /^(\s*)(\d+)\.\s+(.*)$/;

  while (i < lines.length) {
    const line = lines[i];
    const bMatch = line.match(bulletPattern);
    const oMatch = line.match(orderedPattern);
    const match = (listType === 'bullet') ? bMatch : oMatch;

    if (!match && !bMatch && !oMatch) break; // not a list line

    const lineIndent = (match || bMatch || oMatch)[1].length;
    if (lineIndent < indent) break; // dedented past our level

    if (lineIndent > indent) {
      // Nested list - figure out its type
      const nestedType = bMatch ? 'bullet' : 'ordered';
      const nested = parseMarkdownList_(lines, i, nestedType, lineIndent);
      // Attach nested list to the last item
      if (items.length > 0) {
        items[items.length - 1].content.push(nested.node);
      }
      i = nested.nextIndex;
      continue;
    }

    // Same level - this is a list item at our level
    if ((listType === 'bullet' && !bMatch) || (listType === 'ordered' && !oMatch)) break;

    const itemText = (match)[3];
    items.push({
      type: 'listItem',
      content: [{ type: 'paragraph', content: parseInlineMarkdown_(itemText) }]
    });
    i++;
  }

  const nodeType = (listType === 'bullet') ? 'bulletList' : 'orderedList';
  return { node: { type: nodeType, content: items }, nextIndex: i };
}

/**
 * Parse inline Markdown formatting into ADF inline nodes.
 *
 * Handles: **bold**, *italic*, ~~strikethrough~~, `code`, [text](url)
 *
 * @param {string} text - Markdown text (may contain inline formatting)
 * @return {Array} array of ADF inline nodes (text nodes with marks)
 */
function parseInlineMarkdown_(text) {
  if (!text) return [];

  const nodes = [];
  // Regex matches inline patterns in priority order.
  // Each capture group corresponds to a different pattern.
  //   1: code (`...`)
  //   2: link text, 3: link url ([text](url))
  //   4: bold (**...**)
  //   5: strikethrough (~~...~~)
  //   6: italic (*...*)
  const pattern = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|~~(.+?)~~|\*(.+?)\*/g;

  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    // Add preceding plain text
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: text.substring(lastIndex, match.index) });
    }

    if (match[1] !== undefined) {
      // Inline code
      nodes.push({ type: 'text', text: match[1], marks: [{ type: 'code' }] });
    } else if (match[2] !== undefined) {
      // Link
      nodes.push({
        type: 'text', text: match[2],
        marks: [{ type: 'link', attrs: { href: match[3] } }]
      });
    } else if (match[4] !== undefined) {
      // Bold
      nodes.push({ type: 'text', text: match[4], marks: [{ type: 'strong' }] });
    } else if (match[5] !== undefined) {
      // Strikethrough
      nodes.push({ type: 'text', text: match[5], marks: [{ type: 'strike' }] });
    } else if (match[6] !== undefined) {
      // Italic
      nodes.push({ type: 'text', text: match[6], marks: [{ type: 'em' }] });
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining plain text
  if (lastIndex < text.length) {
    nodes.push({ type: 'text', text: text.substring(lastIndex) });
  }

  return nodes.length > 0 ? nodes : [];
}

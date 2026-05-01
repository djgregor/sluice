/**
 * Sluice - Push helpers (Sheet -> Jira)
 *
 * Provides issue creation and update functions used by Sync.gs:
 *   - Rows without a Key -> create new issues
 *   - Rows with a Key    -> update existing issues
 *
 * After creation, the new Key is written back to the sheet.
 * Status changes are handled via Jira transitions.
 * Issue links (DependsOn, Blocking) are managed separately.
 * Last Synced is stamped on every successfully pushed row.
 *
 * Push is not exposed as a standalone menu action — all writes to
 * Jira go through Sync, which validates issues against the filter
 * to prevent accidental changes outside the intended scope.
 */

/* Create issue */

/**
 * @param {Object} rowData   - header -> cell value
 * @param {Array}  columns   - resolved SLUICE_COLUMNS
 * @param {Object} cfg       - sluice config
 * @param {Object} userCache - displayName/email -> accountId cache
 * @return {Object} { key, error }
 */
function createIssue_(rowData, columns, cfg, userCache) {
  const issueType = rowData['Type'] || getDefaultIssueType_();
  const summary = rowData['Summary'] || '';

  if (!summary) {
    return { key: null, error: 'Summary is required to create an issue.' };
  }

  const payload = {
    fields: {
      project: { key: cfg.jiraProject },
      issuetype: { name: issueType },
      summary: summary
    }
  };

  // Description (Jira API v3 requires ADF format)
  if (rowData['Description']) {
    payload.fields.description = markdownToAdf_(rowData['Description']);
  }

  // Environment (Jira API v3 uses ADF, like description)
  if (rowData['Environment']) {
    payload.fields.environment = markdownToAdf_(rowData['Environment']);
  }

  // Priority
  if (rowData['Priority']) {
    payload.fields.priority = { name: rowData['Priority'] };
  }

  // Assignee
  if (rowData['Assignee']) {
    const assigneeId = resolveUserId_(rowData['Assignee'], userCache);
    if (assigneeId) {
      payload.fields.assignee = { accountId: assigneeId };
    }
  }

  // Reporter
  if (rowData['Reporter']) {
    const reporterId = resolveUserId_(rowData['Reporter'], userCache);
    if (reporterId) {
      payload.fields.reporter = { accountId: reporterId };
    }
  }

  // Due date
  if (rowData['Target End Date']) {
    payload.fields.duedate = normalizeDate_(rowData['Target End Date']);
  }

  // Parent
  if (rowData['Parent']) {
    payload.fields.parent = { key: rowData['Parent'] };
  }

  // Components
  if (rowData['Component']) {
    payload.fields.components = rowData['Component'].split(',').map(function (c) {
      return { name: c.trim() };
    }).filter(function (c) { return c.name; });
  }

  // Labels
  if (rowData['Labels']) {
    payload.fields.labels = rowData['Labels'].split(',').map(function (l) {
      return l.trim();
    }).filter(function (l) { return l; });
  }

  // Fix Versions
  if (rowData['Fix Versions']) {
    payload.fields.fixVersions = rowData['Fix Versions'].split(',').map(function (v) {
      return { name: v.trim() };
    }).filter(function (v) { return v.name; });
  }

  // LoE Days custom field
  const loeCol = findColumnDef_(columns, 'LoE Days');
  if (loeCol && loeCol.jiraField.indexOf('customfield_') === 0 && rowData['LoE Days']) {
    const loeVal = parseFloat(rowData['LoE Days']);
    if (!isNaN(loeVal)) {
      payload.fields[loeCol.jiraField] = loeVal;
    }
  }

  // Story Points custom field
  const spCol = findColumnDef_(columns, 'Story Points');
  if (spCol && spCol.jiraField.indexOf('customfield_') === 0 && rowData['Story Points']) {
    const spVal = parseFloat(rowData['Story Points']);
    if (!isNaN(spVal)) {
      payload.fields[spCol.jiraField] = spVal;
    }
  }

  // WorkArea custom field (select/dropdown)
  const waCol = findColumnDef_(columns, 'WorkArea');
  if (waCol && waCol.jiraField.indexOf('customfield_') === 0) {
    const waValue = rowData['WorkArea'] || cfg.workAreaValue;
    if (waValue) {
      payload.fields[waCol.jiraField] = { value: waValue };
    }
  }

  // Bug-specific ADF textarea fields
  const bugAdfFields = [
    { header: 'Steps to Reproduce', configKey: 'bugStepsField' },
    { header: 'Expected Result',    configKey: 'bugExpectedField' },
    { header: 'Actual Results',     configKey: 'bugActualField' },
    { header: 'Actual Outcomes',    configKey: 'bugOutcomesField' }
  ];
  for (let bf = 0; bf < bugAdfFields.length; bf++) {
    const fieldId = cfg[bugAdfFields[bf].configKey];
    if (fieldId && rowData[bugAdfFields[bf].header]) {
      payload.fields[fieldId] = markdownToAdf_(rowData[bugAdfFields[bf].header]);
    }
  }

  // Team custom field (Atlassian Teams expects the GUID as a plain string,
  // not wrapped in { id: ... }).
  if (cfg.teamField && cfg.teamId) {
    payload.fields[cfg.teamField] = cfg.teamId;
  }

  const result = jiraPost('/rest/api/3/issue', payload);
  if (result.error) {
    return { key: null, error: result.error };
  }

  return { key: result.data.key, error: null };
}

/* Update issue */

/**
 * @param {string} key       - issue key (e.g. PROJ-123)
 * @param {Object} rowData   - header -> cell value
 * @param {Array}  columns   - resolved SLUICE_COLUMNS
 * @param {Object} cfg       - sluice config
 * @param {Object} userCache - displayName/email -> accountId cache
 * @return {Object} { error }
 */
function updateIssue_(key, rowData, columns, cfg, userCache) {
  validateIssueKey_(key);
  const payload = { fields: {} };
  let hasFields = false;

  // Summary
  if (rowData['Summary']) {
    payload.fields.summary = rowData['Summary'];
    hasFields = true;
  }

  // Description (Jira API v3 requires ADF format)
  if (rowData.hasOwnProperty('Description')) {
    payload.fields.description = markdownToAdf_(rowData['Description'] || '');
    hasFields = true;
  }

  // Environment (Jira API v3 uses ADF)
  if (rowData['Environment']) {
    payload.fields.environment = markdownToAdf_(rowData['Environment']);
    hasFields = true;
  }

  // Type (can change issue type)
  if (rowData['Type']) {
    payload.fields.issuetype = { name: rowData['Type'] };
    hasFields = true;
  }

  // Priority
  if (rowData['Priority']) {
    payload.fields.priority = { name: rowData['Priority'] };
    hasFields = true;
  }

  // Assignee
  if (rowData.hasOwnProperty('Assignee')) {
    if (rowData['Assignee']) {
      const assigneeId = resolveUserId_(rowData['Assignee'], userCache);
      if (assigneeId) {
        payload.fields.assignee = { accountId: assigneeId };
        hasFields = true;
      }
    } else {
      // Empty assignee = unassign
      payload.fields.assignee = null;
      hasFields = true;
    }
  }

  // Reporter
  if (rowData['Reporter']) {
    const reporterId = resolveUserId_(rowData['Reporter'], userCache);
    if (reporterId) {
      payload.fields.reporter = { accountId: reporterId };
      hasFields = true;
    }
  }

  // Due date (only send if non-empty)
  if (rowData['Target End Date']) {
    payload.fields.duedate = normalizeDate_(rowData['Target End Date']);
    hasFields = true;
  }

  // Parent (only send if non-empty)
  if (rowData['Parent']) {
    payload.fields.parent = { key: rowData['Parent'] };
    hasFields = true;
  }

  // Components (only send if non-empty)
  if (rowData['Component']) {
    payload.fields.components = rowData['Component'].split(',').map(function (c) {
      return { name: c.trim() };
    }).filter(function (c) { return c.name; });
    hasFields = true;
  }

  // Labels (only send if non-empty)
  if (rowData['Labels']) {
    payload.fields.labels = rowData['Labels'].split(',').map(function (l) {
      return l.trim();
    }).filter(function (l) { return l; });
    hasFields = true;
  }

  // Fix Versions (only send if non-empty)
  if (rowData['Fix Versions']) {
    payload.fields.fixVersions = rowData['Fix Versions'].split(',').map(function (v) {
      return { name: v.trim() };
    }).filter(function (v) { return v.name; });
    hasFields = true;
  }

  // LoE Days custom field (only send if non-empty - some screens don't include it)
  const loeCol2 = findColumnDef_(columns, 'LoE Days');
  if (loeCol2 && loeCol2.jiraField.indexOf('customfield_') === 0 && rowData['LoE Days']) {
    const loeVal2 = parseFloat(rowData['LoE Days']);
    if (!isNaN(loeVal2)) {
      payload.fields[loeCol2.jiraField] = loeVal2;
      hasFields = true;
    }
  }

  // Story Points custom field (only send if non-empty)
  const spCol2 = findColumnDef_(columns, 'Story Points');
  if (spCol2 && spCol2.jiraField.indexOf('customfield_') === 0 && rowData['Story Points']) {
    const spVal2 = parseFloat(rowData['Story Points']);
    if (!isNaN(spVal2)) {
      payload.fields[spCol2.jiraField] = spVal2;
      hasFields = true;
    }
  }

  // WorkArea custom field (only send if non-empty - some screens don't include it)
  const waCol = findColumnDef_(columns, 'WorkArea');
  if (waCol && waCol.jiraField.indexOf('customfield_') === 0 && rowData['WorkArea']) {
    payload.fields[waCol.jiraField] = { value: rowData['WorkArea'] };
    hasFields = true;
  }

  // Bug-specific ADF textarea fields (only send if non-empty)
  const bugAdfFields = [
    { header: 'Steps to Reproduce', configKey: 'bugStepsField' },
    { header: 'Expected Result',    configKey: 'bugExpectedField' },
    { header: 'Actual Results',     configKey: 'bugActualField' },
    { header: 'Actual Outcomes',    configKey: 'bugOutcomesField' }
  ];
  for (let bf = 0; bf < bugAdfFields.length; bf++) {
    const fieldId = cfg[bugAdfFields[bf].configKey];
    if (fieldId && rowData.hasOwnProperty(bugAdfFields[bf].header) && rowData[bugAdfFields[bf].header]) {
      payload.fields[fieldId] = markdownToAdf_(rowData[bugAdfFields[bf].header]);
      hasFields = true;
    }
  }

  if (!hasFields) {
    return { error: null }; // nothing to update
  }

  const result = jiraPut('/rest/api/3/issue/' + key, payload);
  if (result.error) {
    return { error: result.error };
  }

  return { error: null };
}

/* Status transitions (multi-hop with workflow sequences) */

/**
 * Transition an issue to the target status, walking through intermediate
 * states using the defined workflow sequences (see Workflows.gs).
 *
 * The function:
 *   1. Looks up the workflow sequence for the issue type
 *   2. Uses the sequence to pick the correct next intermediate status
 *   3. Auto-fills required transition fields (WorkArea, Resolution, etc.)
 *   4. Walks forward until the target status is reached
 *   5. Falls back to first-available if the issue type has no sequence
 *
 * @param {string} key          - issue key
 * @param {string} targetStatus - desired status name
 * @param {string} issueType    - issue type name (Task, Bug, etc.)
 * @param {Object} errors       - error list to append to
 * @param {number} rowNum       - row number for error messages
 */
const MAX_TRANSITION_HOPS = 8;

function handleStatusTransition_(key, targetStatus, issueType, errors, rowNum) {
  if (!targetStatus) return;
  validateIssueKey_(key);

  const visited = {};
  const transitionDefaults = getTransitionDefaults_();
  const path = []; // track the path for error reporting

  for (let hop = 0; hop < MAX_TRANSITION_HOPS; hop++) {
    // Get current issue fields (needed to echo values back on transition screens)
    const issueResult = jiraGet('/rest/api/3/issue/' + key);
    if (issueResult.error) {
      errors.push('Row ' + rowNum + ' (' + key + '): Could not fetch issue: ' + issueResult.error);
      return;
    }

    const issueFields = issueResult.data.fields;
    const currentStatus = issueFields.status.name;
    if (currentStatus.toLowerCase() === targetStatus.toLowerCase()) {
      return; // reached target
    }

    visited[currentStatus.toLowerCase()] = true;
    path.push(currentStatus);

    // Get available transitions (with field requirements)
    const transResult = jiraGetTransitions(key);
    if (transResult.error) {
      errors.push('Row ' + rowNum + ' (' + key + '): Could not get transitions: ' + transResult.error);
      return;
    }

    // Use the workflow sequence to determine the correct next step
    const nextInSeq = issueType ? getNextInSequence_(issueType, currentStatus, targetStatus) : null;

    // Find the right transition to execute
    let chosenTrans = null;
    let directTrans = null;
    let seqTrans = null;
    const candidates = [];

    for (let i = 0; i < transResult.transitions.length; i++) {
      const t = transResult.transitions[i];
      if (!t.to || !t.to.name) continue;

      const toName = t.to.name.toLowerCase();

      // Direct transition to target - always preferred
      if (toName === targetStatus.toLowerCase()) {
        directTrans = t;
        break;
      }

      // Transition to next step in the defined sequence
      if (nextInSeq && toName === nextInSeq.toLowerCase()) {
        seqTrans = t;
      }

      // Collect other unvisited candidates as fallback
      if (!visited[toName] && !isExcludedIntermediate_(toName)) {
        candidates.push(t);
      }
    }

    // Priority: direct > sequence > first unvisited
    chosenTrans = directTrans || seqTrans || (candidates.length > 0 ? candidates[0] : null);

    if (!chosenTrans) {
      const available = transResult.transitions.map(function (t) {
        return t.to ? t.to.name : t.name;
      }).join(', ');
      errors.push(
        'Row ' + rowNum + ' (' + key + '): No path from "' +
        currentStatus + '" to "' + targetStatus +
        '". Path so far: ' + path.join(' → ') +
        '. Available: ' + available
      );
      return;
    }

    // Resolve required transition fields - auto-fill from defaults or current values
    const fieldResult = resolveTransitionFields_(chosenTrans, transitionDefaults, issueFields);
    if (fieldResult.unfilled.length > 0) {
      errors.push(
        'Row ' + rowNum + ' (' + key + '): Transition from "' +
        currentStatus + '" to "' + chosenTrans.to.name +
        '" requires fields: ' + fieldResult.unfilled.join(', ') +
        '. Please complete this transition in Jira.'
      );
      return;
    }

    // Execute the transition (with auto-filled fields if any)
    const doResult = jiraDoTransition(key, chosenTrans.id, fieldResult.fields);
    if (doResult.error) {
      errors.push(
        'Row ' + rowNum + ' (' + key + '): Transition to "' +
        chosenTrans.to.name + '" failed: ' + doResult.error
      );
      return;
    }

    // If this was the direct transition, we're done
    if (directTrans) return;

    // Brief pause between hops to avoid UrlFetchApp throttling
    Utilities.sleep(500);

    // Otherwise, loop to continue walking toward the target
  }

  path.push('…');
  errors.push(
    'Row ' + rowNum + ' (' + key + '): Could not reach "' +
    targetStatus + '" within ' + MAX_TRANSITION_HOPS +
    ' transitions. Path: ' + path.join(' → ') +
    '. Please complete in Jira.'
  );
}

/* Issue links */

/**
 * Manage DependsOn and Blocking issue links.
 * Compares desired links from the sheet against current links in Jira
 * and creates/removes as needed.
 */
function handleLinks_(key, rowData, errors, rowNum) {
  validateIssueKey_(key);
  const dependsOn = parseKeyList_(rowData['DependsOn']);
  const blocking = parseKeyList_(rowData['Blocking']);

  // Only manage links if columns are present and non-empty
  if (dependsOn.length === 0 && blocking.length === 0) return;

  // Fetch current links
  const issueResult = jiraGet('/rest/api/3/issue/' + key, { fields: 'issuelinks' });
  if (issueResult.error) {
    errors.push('Row ' + rowNum + ' (' + key + '): Could not fetch links: ' + issueResult.error);
    return;
  }

  const currentLinks = issueResult.data.fields.issuelinks || [];

  // Build sets of current link targets
  const currentDependsOn = {};
  const currentBlocking = {};
  const linkIdMap = {}; // "type:direction:targetKey" -> link id

  for (let i = 0; i < currentLinks.length; i++) {
    const cl = currentLinks[i];
    const typeName = cl.type ? cl.type.name : '';

    if (typeName === 'Blocks') {
      if (cl.outwardIssue) {
        currentBlocking[cl.outwardIssue.key] = true;
        linkIdMap['Blocks:outward:' + cl.outwardIssue.key] = cl.id;
      }
      if (cl.inwardIssue) {
        currentDependsOn[cl.inwardIssue.key] = true;
        linkIdMap['Blocks:inward:' + cl.inwardIssue.key] = cl.id;
      }
    }
  }

  // Create missing "depends on" links (this issue is blocked by target)
  for (let d = 0; d < dependsOn.length; d++) {
    const depKey = dependsOn[d];
    if (!currentDependsOn[depKey]) {
      const linkResult = jiraPost('/rest/api/3/issueLink', {
        type: { name: 'Blocks' },
        inwardIssue: { key: key },
        outwardIssue: { key: depKey }
      });
      if (linkResult.error) {
        errors.push('Row ' + rowNum + ' (' + key + '): Link DependsOn ' + depKey + ': ' + linkResult.error);
      }
    }
  }

  // Create missing "blocking" links (this issue blocks target)
  for (let b = 0; b < blocking.length; b++) {
    const blockKey = blocking[b];
    if (!currentBlocking[blockKey]) {
      const linkResult2 = jiraPost('/rest/api/3/issueLink', {
        type: { name: 'Blocks' },
        inwardIssue: { key: blockKey },
        outwardIssue: { key: key }
      });
      if (linkResult2.error) {
        errors.push('Row ' + rowNum + ' (' + key + '): Link Blocking ' + blockKey + ': ' + linkResult2.error);
      }
    }
  }
}

/* User resolution */

/**
 * Resolve a display name or email to a Jira accountId.
 * Uses the user search API with caching.
 *
 * @param {string} nameOrEmail
 * @param {Object} cache
 * @return {string|null} accountId or null
 */
function resolveUserId_(nameOrEmail, cache) {
  if (!nameOrEmail) return null;

  // Check cache
  const cacheKey = nameOrEmail.toLowerCase();
  if (cache[cacheKey]) return cache[cacheKey];
  if (cache[cacheKey] === false) return null; // previously failed

  // If it looks like an accountId already (Atlassian format), use it directly
  if (/^[0-9a-f]{24}$/.test(nameOrEmail) || nameOrEmail.indexOf(':') !== -1) {
    cache[cacheKey] = nameOrEmail;
    return nameOrEmail;
  }

  // Search by query (works for both email and display name)
  const result = jiraGet('/rest/api/3/user/search', { query: nameOrEmail, maxResults: 5 });
  if (result.error || !result.data || result.data.length === 0) {
    cache[cacheKey] = false;
    return null;
  }

  // Try exact email match first
  for (let i = 0; i < result.data.length; i++) {
    if (result.data[i].emailAddress &&
        result.data[i].emailAddress.toLowerCase() === cacheKey) {
      cache[cacheKey] = result.data[i].accountId;
      return result.data[i].accountId;
    }
  }

  // Try exact display name match
  for (let j = 0; j < result.data.length; j++) {
    if (result.data[j].displayName &&
        result.data[j].displayName.toLowerCase() === cacheKey) {
      cache[cacheKey] = result.data[j].accountId;
      return result.data[j].accountId;
    }
  }

  // Fall back to first result
  const accountId = result.data[0].accountId;
  cache[cacheKey] = accountId;
  return accountId;
}

/* Helpers */

/**
 * Parse a comma-separated list of issue keys.
 */
function parseKeyList_(value) {
  if (!value) return [];
  return value.split(',')
    .map(function (k) { return k.trim(); })
    .filter(function (k) { return k && /^[A-Z]+-\d+$/.test(k); });
}

/**
 * Normalize a date value to YYYY-MM-DD format.
 * Handles Date objects, ISO strings, and various common formats.
 */
function normalizeDate_(value) {
  if (!value) return null;

  // If it's already YYYY-MM-DD, return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  // Try to parse as a date
  let d;
  if (value instanceof Date) {
    d = value;
  } else {
    d = new Date(value);
  }

  if (isNaN(d.getTime())) return null;

  const year = d.getFullYear();
  const month = ('0' + (d.getMonth() + 1)).slice(-2);
  const day = ('0' + d.getDate()).slice(-2);
  return year + '-' + month + '-' + day;
}

/**
 * Find a column definition by header name.
 */
function findColumnDef_(columns, header) {
  for (let i = 0; i < columns.length; i++) {
    if (columns[i].header === header) return columns[i];
  }
  return null;
}

/**
 * Check if a status name is an excluded intermediate (terminal/side status).
 */
function isExcludedIntermediate_(statusName) {
  const lower = statusName.toLowerCase();
  const excluded = getExcludedIntermediates_();
  for (let i = 0; i < excluded.length; i++) {
    if (excluded[i] === lower) return true;
  }
  return false;
}

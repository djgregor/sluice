/**
 * Sluice - Jira REST API client
 *
 * Thin wrapper around UrlFetchApp that handles auth headers, JSON
 * parsing, and error normalisation. All Jira interactions go through
 * these helpers so auth/base-URL logic lives in one place.
 */

/* Low-level HTTP */

/**
 * Build the Authorization header value (Basic auth with email:apiToken).
 */
function jiraAuthHeader_() {
  const cfg = getConfig();
  const credentials = Utilities.base64Encode(cfg.jiraEmail + ':' + cfg.jiraApiToken);
  return 'Basic ' + credentials;
}

/**
 * Execute an HTTP request against the Jira REST API.
 *
 * @param {string} path     - API path, e.g. '/rest/api/3/myself'
 * @param {Object} [opts]   - Optional overrides:
 *   method   {string}  - HTTP method (default GET)
 *   payload  {Object}  - JSON body (auto-stringified)
 *   params   {Object}  - Query-string parameters
 * @return {Object} { data, statusCode, error }
 */
function jiraFetch_(path, opts) {
  opts = opts || {};
  const cfg = getConfig();

  if (!cfg.jiraBaseUrl) {
    return { data: null, statusCode: 0, error: 'Jira base URL is not configured.' };
  }

  // Validate base URL is HTTPS and points to an Atlassian domain.
  // This prevents credential leakage to arbitrary servers.
  if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net$/i.test(cfg.jiraBaseUrl)) {
    return { data: null, statusCode: 0, error: 'Jira base URL must be https://<org>.atlassian.net' };
  }

  let url = cfg.jiraBaseUrl + path;

  // Append query-string params
  if (opts.params) {
    const qs = Object.keys(opts.params)
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(opts.params[k]); })
      .join('&');
    url += (url.indexOf('?') === -1 ? '?' : '&') + qs;
  }

  const fetchOpts = {
    method: opts.method || 'get',
    headers: {
      'Authorization': jiraAuthHeader_(),
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  };

  if (opts.payload) {
    fetchOpts.contentType = 'application/json';
    fetchOpts.payload = JSON.stringify(opts.payload);
  }

  try {
    const response = UrlFetchApp.fetch(url, fetchOpts);
    const code = response.getResponseCode();
    const body = response.getContentText();
    let data = null;

    if (body) {
      try { data = JSON.parse(body); } catch (e) { data = body; }
    }

    if (code >= 200 && code < 300) {
      return { data: data, statusCode: code, error: null };
    }

    // Build a human-readable error
    let errMsg = 'HTTP ' + code;
    if (data && data.errorMessages && data.errorMessages.length) {
      errMsg += ': ' + data.errorMessages.join('; ');
    }
    if (data && data.errors && typeof data.errors === 'object') {
      const fieldErrors = [];
      for (const ek in data.errors) {
        if (data.errors[ek]) fieldErrors.push(ek + ': ' + data.errors[ek]);
      }
      if (fieldErrors.length) errMsg += ' [' + fieldErrors.join('; ') + ']';
    }
    if (data && data.message && errMsg === 'HTTP ' + code) {
      errMsg += ': ' + data.message;
    }
    return { data: data, statusCode: code, error: errMsg };

  } catch (e) {
    return { data: null, statusCode: 0, error: e.toString() };
  }
}

/* Input validation */

/**
 * Validate that a string looks like a Jira issue key (e.g. "PROJ-123").
 * Prevents path traversal via crafted key values.
 */
function validateIssueKey_(key) {
  if (!key || !/^[A-Z][A-Z0-9]+-\d+$/.test(key)) {
    throw new Error('Invalid issue key: ' + key);
  }
}

/**
 * Validate that a string is a numeric ID (for filter IDs, transition IDs, etc.).
 */
function validateNumericId_(id) {
  if (!id || !/^\d+$/.test(String(id))) {
    throw new Error('Invalid ID: ' + id);
  }
}

/* Convenience methods */

function jiraGet(path, params) {
  return jiraFetch_(path, { method: 'get', params: params });
}

function jiraPost(path, payload) {
  return jiraFetch_(path, { method: 'post', payload: payload });
}

function jiraPut(path, payload) {
  return jiraFetch_(path, { method: 'put', payload: payload });
}

function jiraDelete(path) {
  return jiraFetch_(path, { method: 'delete' });
}

/* Higher-level helpers (used by sync phases) */

/**
 * Search issues using JQL. Handles pagination automatically.
 *
 * @param {string} jql        - JQL query string
 * @param {string[]} fields   - Fields to return
 * @param {number} [maxResults] - Cap on total results (default 1000)
 * @return {Object} { issues: [], error: string|null, truncated: boolean }
 *   truncated: true if we stopped fetching because we hit maxResults and more
 *   pages were still available. Callers that delete based on absence (e.g.
 *   stale-row cleanup) must skip that work when truncated is true.
 */
function jiraSearch(jql, fields, maxResults) {
  maxResults = maxResults || 1000;
  const PAGE_SIZE = 100;
  const allIssues = [];
  const seenKeys = {};

  // The /search/jql endpoint uses cursor-based pagination via nextPageToken.
  // We use POST to avoid URL length limits with long JQL queries.
  let nextPageToken = null;
  let sawIsLast = false;

  while (allIssues.length < maxResults) {
    const payload = {
      jql: jql,
      fields: Array.isArray(fields) ? fields : [],
      maxResults: PAGE_SIZE
    };

    // Use cursor token for subsequent pages
    if (nextPageToken) {
      payload.nextPageToken = nextPageToken;
    }

    const result = jiraPost('/rest/api/3/search/jql', payload);

    if (result.error) {
      return { issues: allIssues, error: result.error, truncated: false };
    }

    const issues = result.data.issues || [];

    // No results returned - done
    if (issues.length === 0) {
      sawIsLast = true;
      break;
    }

    // Deduplicate (safety measure)
    for (const issue of issues) {
      if (!seenKeys[issue.key]) {
        seenKeys[issue.key] = true;
        allIssues.push(issue);
      }
    }

    // isLast flag indicates no more pages
    if (result.data.isLast) {
      sawIsLast = true;
      break;
    }

    // Get cursor for next page
    nextPageToken = result.data.nextPageToken;
    if (!nextPageToken) {
      sawIsLast = true;
      break;
    }
  }

  const truncated = !sawIsLast && allIssues.length >= maxResults;
  return { issues: allIssues, error: null, truncated: truncated };
}

/**
 * Fetch available transitions for an issue.
 *
 * @param {string} issueKey
 * @return {Object} { transitions: [], error: string|null }
 */
function jiraGetTransitions(issueKey) {
  validateIssueKey_(issueKey);
  const result = jiraGet('/rest/api/3/issue/' + issueKey + '/transitions', {
    expand: 'transition.fields'
  });
  if (result.error) {
    return { transitions: [], error: result.error };
  }
  return { transitions: result.data.transitions || [], error: null };
}

/**
 * Transition an issue to a new status, optionally providing field values
 * required by the transition screen.
 *
 * @param {string} issueKey
 * @param {string} transitionId
 * @param {Object} [fields] - optional field values to include in the transition
 * @return {Object} { success: boolean, error: string|null }
 */
function jiraDoTransition(issueKey, transitionId, fields) {
  validateIssueKey_(issueKey);
  validateNumericId_(transitionId);
  const payload = {
    transition: { id: transitionId }
  };
  if (fields && Object.keys(fields).length > 0) {
    payload.fields = fields;
  }
  const result = jiraPost('/rest/api/3/issue/' + issueKey + '/transitions', payload);
  if (result.error) {
    return { success: false, error: result.error };
  }
  return { success: true, error: null };
}

/**
 * Fetch the saved filter's JQL by filter ID.
 *
 * @param {string} filterId
 * @return {Object} { jql: string, name: string, error: string|null }
 */
function jiraGetFilter(filterId) {
  validateNumericId_(filterId);
  const result = jiraGet('/rest/api/3/filter/' + filterId);
  if (result.error) {
    return { jql: null, name: null, error: result.error };
  }
  return { jql: result.data.jql, name: result.data.name, error: null };
}

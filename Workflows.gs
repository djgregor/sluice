/**
 * Sluice - Workflow configuration
 *
 * Defines the expected status progression for each issue type so multi-hop
 * transitions can navigate through intermediate states correctly.
 *
 * Customize these sequences for your Jira instance's workflows.
 * Status names must match Jira exactly (case-insensitive matching is used).
 */

/* Status sequences by issue type */

const SLUICE_WORKFLOWS = {
  'task':       ['Draft', 'TO DO', 'In Progress', 'Verifying', 'Done'],
  'spike':      ['Draft', 'TO DO', 'In Progress', 'Verifying', 'Done'],
  'bug':        ['Triage', 'TO DO', 'Dev In Progress', 'Resolved', 'Ready For QA', 'QA In Progress', 'Done'],
  'tech story': ['Draft', 'Ready for Grooming', 'Dev In Progress', 'Review', 'Done'],
  'story':      ['Draft', 'BA in Progress', 'Dev In Progress', 'Done'],
  'epic':       ['Draft', 'Scheduled for Analysis', 'Analyzing', 'Analyzed'],
  'service request': ['Draft', 'TO DO', 'In Progress', 'Verifying', 'Done']
};

/**
 * Statuses that should never be used as intermediate hops.
 * These are terminal or side statuses that the multi-hop walker
 * should only transition to if they are the explicit target.
 */
const SLUICE_EXCLUDED_INTERMEDIATES = [
  "won't fix",
  'blocked',
  'descope task',
  'cancelled',
  'canceled'
];

/* Sequence lookup */

/**
 * Given an issue type, current status, and target status, return the next
 * status in the defined sequence (i.e. the correct intermediate step).
 *
 * Returns null if:
 *   - The issue type has no defined sequence
 *   - Either status isn't in the sequence
 *   - The target is behind the current position (backward move)
 *
 * In those cases the caller falls back to Jira's available transitions.
 *
 * @param {string} issueType     - e.g. "Task", "Bug"
 * @param {string} currentStatus - current Jira status name
 * @param {string} targetStatus  - desired status name
 * @return {string|null} the next status to transition to, or null
 */
function getNextInSequence_(issueType, currentStatus, targetStatus) {
  const seq = SLUICE_WORKFLOWS[issueType.toLowerCase()];
  if (!seq) return null;

  let currentIdx = -1;
  let targetIdx = -1;
  const currentLower = currentStatus.toLowerCase();
  const targetLower = targetStatus.toLowerCase();

  for (let i = 0; i < seq.length; i++) {
    if (seq[i].toLowerCase() === currentLower) currentIdx = i;
    if (seq[i].toLowerCase() === targetLower) targetIdx = i;
  }

  // Both must be in the sequence, and target must be ahead
  if (currentIdx === -1 || targetIdx === -1) return null;
  if (targetIdx <= currentIdx) return null;

  // Return the next step (which might be the target itself)
  return seq[currentIdx + 1];
}

/* Transition field auto-fill */

/**
 * Build a map of field values to auto-fill during transitions.
 * Used when a transition screen requires fields that have known defaults.
 *
 * @return {Object} fieldId -> field value (in Jira API format)
 */
function getTransitionDefaults_() {
  const cfg = getConfig();
  const defaults = {};

  // WorkArea (select field)
  if (cfg.workAreaField && cfg.workAreaValue) {
    defaults[cfg.workAreaField] = { value: cfg.workAreaValue };
  }

  // Resolution (standard Jira field, used for Done transitions on Stories etc.)
  defaults['resolution'] = { name: 'Done' };

  return defaults;
}

/**
 * Attempt to auto-fill required transition fields from known defaults
 * and the issue's current field values.
 *
 * Jira transition screens mark fields as "required" even when they're
 * already populated on the issue - they just need to be present in the
 * transition payload. So we fetch current values as a fallback.
 *
 * @param {Object}   transition   - transition object from Jira API
 * @param {Object}   defaults     - from getTransitionDefaults_()
 * @param {Object}   issueFields  - current issue fields from Jira
 * @return {Object}  { fields: {}, unfilled: [] }
 */
function resolveTransitionFields_(transition, defaults, issueFields) {
  const fields = {};
  const unfilled = [];

  if (!transition.fields) {
    return { fields: fields, unfilled: unfilled };
  }

  for (const fieldId in transition.fields) {
    const field = transition.fields[fieldId];
    if (field.required) {
      if (defaults[fieldId]) {
        // Use configured default (WorkArea, Resolution, etc.)
        fields[fieldId] = defaults[fieldId];
      } else if (issueFields && issueFields[fieldId] != null) {
        // Echo back the issue's current value
        fields[fieldId] = issueFields[fieldId];
      } else {
        unfilled.push(field.name || fieldId);
      }
    }
  }

  return { fields: fields, unfilled: unfilled };
}

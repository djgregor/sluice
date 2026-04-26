/**
 * Sluice - Configuration helpers
 *
 * Stores per-user settings in PropertiesService.getUserProperties() so each
 * collaborator can use their own Jira credentials.
 *
 * Stored keys:
 *   sluice.jiraBaseUrl   - e.g. https://myorg.atlassian.net
 *   sluice.jiraEmail     - Jira account email
 *   sluice.jiraApiToken  - Jira API token (https://id.atlassian.com/manage-profile/security/api-tokens)
 *   sluice.jiraProject   - Default project key (e.g. MYPROJ)
 *   sluice.loeField      - Custom field ID for "LoE Days" (e.g. customfield_10050)
 *   sluice.workAreaField - Custom field ID for "WorkArea" (e.g. customfield_12504)
 *   sluice.workAreaValue - Default WorkArea value for transitions
 *   sluice.teamField     - Custom field ID for "Team" (e.g. customfield_XXXXX)
 *   sluice.teamId        - Default Team ID for issue creation
 *   sluice.bugStepsField    - Custom field ID for "Steps to Reproduce" (Bug-specific)
 *   sluice.bugExpectedField - Custom field ID for "Expected Result" (Bug-specific)
 *   sluice.bugActualField   - Custom field ID for "Actual Results" (Bug-specific)
 *   sluice.bugOutcomesField - Custom field ID for "Actual Outcomes" (Bug-specific)
 *   sluice.sprintField      - Custom field ID for "Sprint" (e.g. customfield_XXXXX)
 *   sluice.storyPointsField - Custom field ID for "Story Points" (e.g. customfield_XXXXX)
 */

const PROP_PREFIX = 'sluice.';

/* Read / write helpers */

function getConfig() {
  const props = PropertiesService.getUserProperties();

  // Shared defaults (set at install time via Defaults.gs) provide fallback
  // values so team members only need to enter their email and API token.
  const defaults = typeof SLUICE_DEFAULTS !== 'undefined' ? SLUICE_DEFAULTS : {};

  return {
    jiraBaseUrl:   (props.getProperty(PROP_PREFIX + 'jiraBaseUrl') || defaults.jiraBaseUrl || '').replace(/\/+$/, ''),
    jiraEmail:     props.getProperty(PROP_PREFIX + 'jiraEmail') || defaults.jiraEmail || '',
    jiraApiToken:  props.getProperty(PROP_PREFIX + 'jiraApiToken') || '',
    jiraProject:   props.getProperty(PROP_PREFIX + 'jiraProject') || defaults.jiraProject || '',
    loeField:      props.getProperty(PROP_PREFIX + 'loeField') || defaults.loeField || '',
    workAreaField: props.getProperty(PROP_PREFIX + 'workAreaField') || defaults.workAreaField || '',
    workAreaValue: props.getProperty(PROP_PREFIX + 'workAreaValue') || defaults.workAreaValue || '',
    teamField:     props.getProperty(PROP_PREFIX + 'teamField') || defaults.teamField || '',
    teamId:        props.getProperty(PROP_PREFIX + 'teamId') || defaults.teamId || '',
    bugStepsField:    props.getProperty(PROP_PREFIX + 'bugStepsField') || defaults.bugStepsField || '',
    bugExpectedField: props.getProperty(PROP_PREFIX + 'bugExpectedField') || defaults.bugExpectedField || '',
    bugActualField:   props.getProperty(PROP_PREFIX + 'bugActualField') || defaults.bugActualField || '',
    bugOutcomesField: props.getProperty(PROP_PREFIX + 'bugOutcomesField') || defaults.bugOutcomesField || '',
    sprintField:      props.getProperty(PROP_PREFIX + 'sprintField') || defaults.sprintField || '',
    storyPointsField: props.getProperty(PROP_PREFIX + 'storyPointsField') || defaults.storyPointsField || '',
    maxResults:       parseInt(props.getProperty(PROP_PREFIX + 'maxResults') || defaults.maxResults || '1000', 10) || 1000
  };
}

function saveConfig(cfg) {
  const props = PropertiesService.getUserProperties();
  props.setProperty(PROP_PREFIX + 'jiraBaseUrl',  (cfg.jiraBaseUrl || '').replace(/\/+$/, ''));
  props.setProperty(PROP_PREFIX + 'jiraEmail',    cfg.jiraEmail || '');
  props.setProperty(PROP_PREFIX + 'jiraApiToken', cfg.jiraApiToken || '');
  props.setProperty(PROP_PREFIX + 'jiraProject',  cfg.jiraProject || '');
  props.setProperty(PROP_PREFIX + 'loeField',     cfg.loeField || '');
  props.setProperty(PROP_PREFIX + 'workAreaField', cfg.workAreaField || '');
  props.setProperty(PROP_PREFIX + 'workAreaValue', cfg.workAreaValue || '');
  props.setProperty(PROP_PREFIX + 'teamField',     cfg.teamField || '');
  props.setProperty(PROP_PREFIX + 'teamId',        cfg.teamId || '');
  props.setProperty(PROP_PREFIX + 'bugStepsField',    cfg.bugStepsField || '');
  props.setProperty(PROP_PREFIX + 'bugExpectedField', cfg.bugExpectedField || '');
  props.setProperty(PROP_PREFIX + 'bugActualField',   cfg.bugActualField || '');
  props.setProperty(PROP_PREFIX + 'bugOutcomesField', cfg.bugOutcomesField || '');
  props.setProperty(PROP_PREFIX + 'sprintField',      cfg.sprintField || '');
  props.setProperty(PROP_PREFIX + 'storyPointsField', cfg.storyPointsField || '');
  const maxRes = Math.max(1, Math.min(5000, parseInt(cfg.maxResults, 10) || 1000));
  props.setProperty(PROP_PREFIX + 'maxResults', String(maxRes));
}

/**
 * Called from sidebar to persist settings and return a status message.
 */
function saveSettings(formData) {
  saveConfig({
    jiraBaseUrl:  formData.jiraBaseUrl,
    jiraEmail:    formData.jiraEmail,
    jiraApiToken: formData.jiraApiToken,
    jiraProject:  formData.jiraProject,
    loeField:     formData.loeField,
    workAreaField: formData.workAreaField,
    workAreaValue: formData.workAreaValue,
    teamField:     formData.teamField,
    teamId:        formData.teamId,
    bugStepsField:    formData.bugStepsField,
    bugExpectedField: formData.bugExpectedField,
    bugActualField:   formData.bugActualField,
    bugOutcomesField: formData.bugOutcomesField,
    sprintField:      formData.sprintField,
    storyPointsField: formData.storyPointsField,
    maxResults:       formData.maxResults
  });
  return { success: true, message: 'Settings saved.' };
}

/**
 * Called from sidebar on load to populate the form.
 */
function loadSettings() {
  return getConfig();
}

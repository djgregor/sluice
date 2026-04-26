/**
 * Sluice - Bidirectional Google Sheets <-> Jira Sync
 * Version: 0.5.0
 *
 * Main entry point. Sets up the Sheets custom menu and
 * dispatches top-level actions.
 */

const SLUICE_VERSION = '0.5.0';

/* Menu */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Sluice')
    .addItem('Sync Sheet ↔ Jira', 'syncCurrentSheet')
    .addItem('Pull from Jira', 'pullFromJira')
    .addItem('Dry Run Sync', 'dryRunSync')
    .addSeparator()
    .addItem('Settings…', 'showSettings')
    .addItem('Test Connection', 'testConnection')
    .addToUi();
}

/* Settings sidebar */

function showSettings() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Sluice Settings')
    .setWidth(400)
    .setHeight(900);
  SpreadsheetApp.getUi().showModalDialog(html, 'Sluice Settings');
}

/* Connection test (called from menu and from sidebar) */

function testConnection() {
  const cfg = getConfig();
  if (!cfg.jiraBaseUrl || !cfg.jiraEmail || !cfg.jiraApiToken) {
    SpreadsheetApp.getUi().alert(
      'Sluice - Missing Configuration',
      'Please open Settings and enter your Jira base URL, email, and API token.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    return { success: false, message: 'Missing configuration' };
  }

  const result = jiraGet('/rest/api/3/myself');
  if (result.error) {
    SpreadsheetApp.getUi().alert(
      'Sluice - Connection Failed',
      'Could not reach Jira:\n' + result.error,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    return { success: false, message: result.error };
  }

  const displayName = result.data.displayName || result.data.emailAddress || 'Unknown';
  SpreadsheetApp.getUi().alert(
    'Sluice - Connected',
    'Successfully connected to Jira as:\n' + displayName,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
  return { success: true, message: 'Connected as ' + displayName };
}

/**
 * Lightweight connection test callable from the sidebar without triggering
 * a modal alert dialog.
 */
function testConnectionSilent() {
  const cfg = getConfig();
  if (!cfg.jiraBaseUrl || !cfg.jiraEmail || !cfg.jiraApiToken) {
    return { success: false, message: 'Missing configuration - fill in all fields.' };
  }
  const result = jiraGet('/rest/api/3/myself');
  if (result.error) {
    return { success: false, message: result.error };
  }
  const displayName = result.data.displayName || result.data.emailAddress || 'Unknown';
  return { success: true, message: 'Connected as ' + displayName };
}

// syncCurrentSheet() is defined in Sync.gs

// pullFromJira() is defined in Pull.gs

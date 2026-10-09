import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { localizeWebview } from './localization';

export function projectEditorHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('hex');
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const t = (message: string) => escape(vscode.l10n.t(message));
  const script = escape(webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'project-settings.js')).toString());
  const style = escape(webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'project-settings.css')).toString());
  return `<!doctype html>
<html lang="${escape(vscode.env.language)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escape(webview.cspSource)}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>${t('UmJoonSIC project settings')}</title>
</head>
<body>
  <main>
    <form id="settings-form">
      <header>
        <div><h1>${t('Project settings')}</h1><p id="file-name" class="file-name"></p></div>
        <div class="save-actions"><span id="save-status" role="status" aria-live="polite">${t('Loading…')}</span><button id="save" title="${t('Save changes to the .sic file. (Ctrl/Cmd+S)')}" type="submit" disabled>${t('Save')}</button></div>
      </header>
      <div id="error" class="error" role="alert" hidden></div>
      <div id="invalid-actions" hidden><button id="open-text" title="${t('Open the .sic file as JSON text to fix it.')}" type="button" class="secondary">${t('Edit as text')}</button></div>
      <fieldset id="settings" disabled>
        <legend class="visually-hidden">${t('Project settings')}</legend>
        <section aria-labelledby="run-title">
          <h2 id="run-title">${t('Execution')}</h2>
          <div class="field"><label for="main-section">${t('Main program')}</label><input id="main-section" list="main-candidates" placeholder="${t('Use file order')}" autocomplete="off" spellcheck="false" aria-describedby="main-help main-warning"><datalist id="main-candidates"></datalist><p id="main-help" class="help">${t('A START program or control section name. Leave empty to use file order.')}</p><p id="main-warning" class="help warning" role="status" hidden></p></div>
          <div class="settings-grid">
            <div class="field"><label for="mode">${t('Machine mode')}</label><select id="mode"><option value="sic">SIC</option><option value="sicxe">SIC/XE</option></select></div>
            <div class="field"><label for="step-delay">${t('Step interval')}</label><div class="with-unit"><input id="step-delay" type="number" min="0" max="60000" step="1" required aria-describedby="delay-help"><span>ms</span></div><p id="delay-help" class="help">${t('0 runs without waiting.')}</p></div>
          </div>
        </section>
        <section aria-labelledby="sources-title">
          <div class="section-heading"><h2 id="sources-title">${t('Assembly files')} <span class="label-hint">Asm List</span></h2><span id="source-count" class="count"></span></div>
          <p class="help section-help">${t('Files are assembled in this order. Paths are relative to the project file.')}</p>
          <ol id="source-list" class="file-list"></ol>
          <span id="order-status" class="visually-hidden" role="status" aria-live="polite"></span>
          <p id="sources-empty" class="empty">${t('Add an .asm file to run.')}</p>
          <label for="source-path">${t('Add an assembly file')}</label>
          <div class="add-source"><input id="source-path" list="source-candidates" placeholder="main.asm" autocomplete="off" spellcheck="false"><datalist id="source-candidates"></datalist><button id="add-source" title="${t('Add the entered .asm file to the end of the list.')}" type="button" class="secondary">${t('Add')}</button><button id="pick-sources" title="${t('Choose one or more .asm files to add.')}" type="button" class="secondary">${t('Choose files…')}</button></div>
        </section>
        <section aria-labelledby="devices-title">
          <div class="section-heading"><h2 id="devices-title">${t('File devices')} <span class="label-hint">Device List</span></h2><span id="device-count" class="count"></span></div>
          <p class="help section-help">${t('Devices referenced by RD · WD · TD and their connected files.')}</p>
          <ul id="device-list" class="file-list"></ul>
          <p id="devices-empty" class="empty">${t('No devices detected or connected.')}</p>
          <label for="device-index">${t('Device number')}</label>
          <div class="add-device"><select id="device-index"></select><button id="new-device" title="${t('Create and connect a new file for the selected device.')}" type="button" class="secondary">${t('New file')}</button><button id="pick-device" title="${t('Choose a file for the selected device.')}" type="button" class="secondary">${t('Connect…')}</button></div>
          <p id="device-help" class="help"></p>
        </section>
      </fieldset>
      <footer id="save-help">${t('Save changes before running the project.')}</footer>
    </form>
  </main>
  ${localizeWebview(webview, extensionUri, nonce)}
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

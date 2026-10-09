import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { localizeWebview } from './localization';
const t = (message: string) => vscode.l10n.t(message).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function listingHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('hex');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'listing.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'listing.css'));
  return `<!doctype html>
<html lang="${vscode.env.language.startsWith('ko') ? 'ko' : 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>${t("UmJoonSIC listing")}</title>
</head>
<body>
  <header>
    <span id="file-name"></span>
    <button id="open-source" type="button" title="${t("Open the selected source row. During execution, open the launch snapshot. (F12 or Enter)")}" disabled>${t("Open source")}</button>
    <label id="flags-option" hidden><input id="show-flags" type="checkbox" title="${t("Show or hide SIC/XE addressing flag bits.")}" checked> NIXBPE</label>
    <button id="state" type="button" title="${t('Show current instruction')}"></button>
  </header>
  <nav id="file-tabs" role="tablist" aria-label="${t('Source files')}"></nav>
  <div id="error" role="alert" hidden></div>
  <p id="empty" role="status">${t("Loading listing…")}</p>
  <main id="table-scroll" tabindex="0" aria-label="${t("Assembly listing")}">
    <table id="listing-table">
      <thead><tr>
        <th class="gutter"><span class="visually-hidden">${t("Breakpoints and execution position")}</span></th>
        <th scope="col">${t("Address")}</th><th scope="col">${t("Raw Hex")}</th><th scope="col">${t("Label")}</th>
        <th scope="col">${t("Instruction")}</th><th scope="col">${t("Operand")}</th><th scope="col">${t("Comment")}</th>
        <th scope="col" class="flags">NIXBPE</th><th scope="col">${t("Raw Code Binary")}</th>
        <th scope="col" title="${t("Opcode bits: eight for SIC and formats 1/2, six for XE formats 3/4.")}">${t("Instruction Binary")}</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </main>
  ${localizeWebview(webview, extensionUri, nonce)}<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

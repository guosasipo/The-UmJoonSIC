import * as vscode from 'vscode';

const attribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Share only the native translation bundle; source buffers and paths are never translated. */
export function localizeWebview(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'localization.js'));
  const bundle = JSON.stringify(vscode.l10n.bundle ?? {});
  return `<script nonce="${attribute(nonce)}" src="${attribute(script.toString())}" data-l10n="${attribute(bundle)}"></script>`;
}

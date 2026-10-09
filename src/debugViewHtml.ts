import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { localizeWebview } from './localization';

const paths = {
  run: '<path d="m5 3 8 5-8 5Z" fill="currentColor" stroke="none"/>',
  assemble: '<path d="m3 2 4 4-2 2-4-4M6 7l7 7m-5-5 3-3M10 2l3 1 1 3-3 3-4-4Z"/>',
  debug: '<path d="M5 6h6v5a3 3 0 0 1-6 0V6ZM6 6V4h4v2M3 8h2m6 0h2M3 11h2m6 0h2M5 3l1 1m4 0 1-1M8 7v6"/>',
  pause: '<path d="M5 3v10M11 3v10" stroke-width="2.5"/>',
  stepIn: '<path d="M8 2v8m-3-3 3 3 3-3M4 14h8"/>',
  next: '<path d="M3 8a5 5 0 0 1 10 0m-3-2 3 3 2-3M6 13h4"/>',
  stepOut: '<path d="M8 11V3M5 6l3-3 3 3M4 14h8"/>',
  restart: '<path d="M3 6a5 5 0 1 1 0 5M3 2v4h4"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>',
  settings: '<path d="M3 4h10M3 8h10M3 12h10M6 2v4M10 6v4M6 10v4"/>',
  delay: '<circle cx="8" cy="8" r="5.5"/><path d="M8 4v4l3 2"/>',
  previous: '<path d="m10 3-5 5 5 5"/>',
  following: '<path d="m6 3 5 5-5 5"/>',
  copy: '<path d="M6 5V2h7v9h-3"/><rect x="3" y="5" width="7" height="9" rx="1"/>',
} as const;
const icon = (name: keyof typeof paths) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
const control = (action: string, name: keyof typeof paths, label: string, text = '', options = '') =>
  `<button type="button" class="tool-button${text ? ' with-text' : ''}" data-action="${action}" title="${t(label)}" aria-label="${t(label)}" ${options}>${icon(name)}${text ? `<span>${t(text)}</span>` : ''}</button>`;
const attribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const t = (message: string) => attribute(vscode.l10n.t(message));

export function debugViewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('hex');
  const script = attribute(webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'debug-view.js')).toString());
  const style = attribute(webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'debug-view.css')).toString());
  const registers = ['A', 'X', 'L', 'B', 'S', 'T', 'SW', 'PC', 'F'].map(name =>
    `<div class="register${name === 'F' ? ' register-wide' : ''}" id="register-${name}"><dt>${name}</dt><dd id="value-${name}">—</dd></div>`).join('');
  return `<!doctype html>
<html lang="${attribute(vscode.env.language)}"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${attribute(webview.cspSource)}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"><title>${t("SIC debugger")}</title></head>
<body><main class="debug-app">
<section class="execution" aria-label="${t("Execution controls")}">
  <div class="session-heading"><span id="mode" class="mode-chip">SIC</span><span id="session-title" class="session-title">${t("Select a source to run")}</span><button type="button" id="state" class="state-label" title="${t('Show current instruction')}">${t("Idle")}</button></div>
  <div class="toolbar" role="group" aria-label="${t("Program controls")}">
    ${control('run', 'run', "Run: assemble the sources and start execution.", "Run")}
    ${control('debug', 'debug', "Debug: assemble the sources and stop before the first instruction.", "Debug")}
    ${control('assemble', 'assemble', "Assemble: generate object code and a listing without running.")}
    ${control('continue', 'run', "Continue at the selected interval, stopping at breakpoints.", '', 'hidden disabled')}
    ${control('pause', 'pause', "Pause execution and keep register and memory values.", '', 'hidden disabled')}
    <span class="toolbar-divider" aria-hidden="true"></span>
    ${control('stepIn', 'stepIn', "Step Into: execute one instruction, entering a JSUB subroutine.", '', 'disabled')}
    ${control('next', 'next', "Step Over: execute one instruction, running JSUB until it returns.", '', 'disabled')}
    ${control('stepOut', 'stepOut', "Step Out: run until the current subroutine returns.", '', 'disabled')}
    <span class="toolbar-divider" aria-hidden="true"></span>
    ${control('restart', 'restart', "Restart: reset the CPU and memory using the current source snapshot. Stop and launch again to use edited sources.", '', 'disabled')}
    ${control('stop', 'stop', "Stop the debug session. A new launch starts from the beginning.", '', 'disabled')}
    ${control('settings', 'settings', "Project settings: configure sources, entry section, machine mode, and file devices.")}
  </div>
  <div class="execution-footer"><span id="statistics"></span><select id="delay-presets" aria-label="${t('Execution interval')}" title="${t('Execution interval')}"><option value="0">${t('Full speed')}</option><option value="100">100 ms</option><option value="250" selected>250 ms</option><option value="500">500 ms</option><option value="1000">1000 ms</option><option value="custom">${t('Custom…')}</option></select><button type="button" class="delay-button" data-action="delay" title="${t("Set the interval between instructions in milliseconds. Zero runs at full speed.")}" aria-label="${t("Change execution interval")}">${icon('delay')}<span id="delay"></span></button></div>
  <p id="detail" class="detail" hidden></p>
</section>
<section class="registers" aria-labelledby="register-heading">
  <div class="section-heading"><h2 id="register-heading">${t("Registers")}</h2><button type="button" id="hex-toggle" class="hex-toggle" aria-pressed="true" title="${t("Display register values in hexadecimal or decimal.")}">HEX MODE</button></div>
  <dl class="register-grid">${registers}</dl>
</section>
<section class="memory" aria-labelledby="memory-heading">
  <div class="section-heading"><h2 id="memory-heading">${t("Memory")}</h2><div class="memory-actions" role="group" aria-label="${t("Memory navigation and copy")}"><button type="button" id="last-write" class="tool-button" title="${t('Show last memory write')}" aria-label="${t('Show last memory write')}" disabled>${icon('stepIn')}</button><button type="button" id="previous" class="tool-button" title="${t("Show the previous memory page.")}" aria-label="${t("Previous memory page")}" disabled>${icon('previous')}</button><button type="button" id="following" class="tool-button" title="${t("Show the next memory page.")}" aria-label="${t("Next memory page")}" disabled>${icon('following')}</button><button type="button" id="copy-memory" class="tool-button" title="${t("Copy the visible memory bytes as hexadecimal.")}" aria-label="${t("Copy memory as hex")}" disabled>${icon('copy')}</button></div></div>
  <form id="memory-form" class="memory-search"><label for="address" class="visually-hidden">${t("Memory address or symbol")}</label><input id="address" type="text" value="0x000000" placeholder="${t("Address or symbol")}" autocomplete="off" spellcheck="false" aria-describedby="memory-range" disabled><label for="count" class="visually-hidden">${t("Bytes per page")}</label><select id="count" title="${t("Bytes per page")}" disabled><option value="128">128 B</option><option value="256" selected>256 B</option><option value="512">512 B</option><option value="1024">1 KB</option><option value="4096">4 KB</option></select><button type="submit" id="read-memory" class="go-button" title="${t("Show memory at the entered address or symbol.")}" disabled>${t("Go")}</button></form>
  <p id="error" class="error" role="alert" hidden></p>
  <div class="memory-scroll"><table aria-label="${t("Memory, eight bytes per row")}"><thead><tr><th scope="col" class="address-column">${t("Address")}</th>${Array.from({ length: 8 }, (_, index) => `<th scope="col">${index.toString(16).toUpperCase().padStart(2, '0')}</th>`).join('')}<th scope="col" class="ascii">ASCII</th></tr></thead><tbody id="memory-body"><tr><td colspan="10" class="empty">${t("Memory appears after launching.")}</td></tr></tbody></table></div>
  <div class="memory-footer"><span id="memory-range">—</span><span class="memory-legend"><span class="legend-pc">PC</span><span class="legend-changed">${t("Changed")}</span><span class="legend-symbol">${t("Symbol")}</span></span></div>
</section>
<details class="devices" id="devices-panel" hidden><summary>${t('Devices')}</summary>
  <div class="device-toolbar"><select id="device-select" aria-label="${t('Device')}"></select><select id="device-format" aria-label="${t('Byte display')}"><option value="hex">Hex</option><option value="text">${t('Text')}</option></select><button id="device-refresh" type="button" title="${t('Refresh device data')}" aria-label="${t('Refresh device data')}">${icon('restart')}</button><button id="device-open" type="button" title="${t('Open device file')}">${t('Open')}</button><button id="device-reset" type="button" title="${t('Clear connected file after confirmation')}">${t('Clear file')}</button></div>
  <p id="device-status" class="detail" role="status"></p>
  <div id="device-input-group"><h3>${t('Next input')}</h3><pre id="device-input" class="device-stream"></pre></div>
  <div class="device-stream-heading"><h3>${t('Read')}</h3><button type="button" id="copy-device-read" title="${t('Copy received bytes')}">${t('Copy')}</button></div><pre id="device-read" class="device-stream"></pre>
  <div class="device-stream-heading"><h3 id="device-write-heading">${t('Written')}</h3><button type="button" id="copy-device-write" title="${t('Copy transmitted bytes')}">${t('Copy')}</button></div><pre id="device-write" class="device-stream"></pre>
</details>
</main>${localizeWebview(webview, extensionUri, nonce)}<script nonce="${nonce}" src="${script}"></script></body></html>`;
}

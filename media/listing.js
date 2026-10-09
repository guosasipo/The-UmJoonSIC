(() => {
  const vscode = acquireVsCodeApi();
  const t = globalThis.umjoonsicL10n.t;
  const byId = id => document.getElementById(id);
  const saved = vscode.getState() || {};
  let rows = [], sources = [], activeUri = saved.activeUri || '';
  let sessionId = '', revision = 0, selectionVersion = 0, snapshot = {}, selectedIndex = -1;
  let fileRows = new Map(), pcRows = new Map(), rendered = new Map(), breakpointKeys = new Set();
  let currentElement;
  const flags = byId('show-flags');
  flags.checked = saved.showFlags !== false;
  const hex = value => Number.isInteger(value) ? value.toString(16).toUpperCase().padStart(6, '0') : '';
  const name = uri => {
    const value = uri.split('/').pop() || uri;
    try { return decodeURIComponent(value); } catch { return value; }
  };
  const remember = () => vscode.setState({ activeUri, showFlags: flags.checked });
  const send = (type, index, symbol) => { byId('error').hidden = true; vscode.postMessage({ type, index, symbol, sessionId, revision }); };
  const currentIndex = () => pcRows.get(snapshot.pc) ?? -1;
  const breakpointKey = row => `${row.uri}\0${row.line}`;

  function selectRow(index, notify = true) {
    const previous = rendered.get(selectedIndex)?.element;
    if (previous) { previous.classList.remove('selected'); previous.tabIndex = -1; }
    selectedIndex = index;
    const selected = rendered.get(index)?.element;
    if (selected) { selected.classList.add('selected'); selected.tabIndex = 0; }
    byId('open-source').disabled = index < 0;
    if (notify) vscode.postMessage({ type: 'select', index, uri: activeUri, sessionId, revision, selectionVersion });
  }

  function reveal(index) {
    if (!Number.isInteger(index) || !rows[index]) return;
    byId('error').hidden = true;
    activeUri = rows[index].uri;
    selectedIndex = index;
    renderFiles();
    rendered.get(index)?.element.scrollIntoView({ block: 'center', inline: 'nearest' });
    rendered.get(index)?.element.focus({ preventScroll: true });
  }

  function updatePC() {
    const next = rendered.get(currentIndex());
    if (next === currentElement) return;
    if (currentElement) {
      currentElement.element.classList.remove('current');
      currentElement.element.removeAttribute('aria-current');
      currentElement.pc.textContent = '';
    }
    if (next) {
      next.element.classList.add('current');
      next.element.setAttribute('aria-current', 'step');
      next.pc.textContent = '→';
    }
    currentElement = next;
  }

  function updateBreakpoints() {
    for (const [index, { button }] of rendered) {
      if (!button) continue;
      const row = rows[index], enabled = breakpointKeys.has(breakpointKey(row));
      button.classList.toggle('enabled', enabled);
      button.setAttribute('aria-pressed', String(enabled));
      button.setAttribute('aria-label', t(enabled ? 'Remove breakpoint on line {0}' : 'Add breakpoint on line {0}', row.line + 1));
      button.title = t(enabled ? 'Remove breakpoint on line {0}' : 'Stop before executing line {0}', row.line + 1);
    }
  }

  function renderRows() {
    const body = byId('rows');
    body.replaceChildren();
    rendered = new Map();
    currentElement = undefined;
    if (rows[selectedIndex]?.uri !== activeUri) selectedIndex = fileRows.get(activeUri)?.[0] ?? -1;
    const fragment = document.createDocumentFragment();
    for (const index of fileRows.get(activeUri) || []) {
      const row = rows[index];
      const tr = document.createElement('tr');
      tr.dataset.index = String(index);
      tr.tabIndex = index === selectedIndex ? 0 : -1;
      tr.classList.toggle('selected', index === selectedIndex);
      tr.title = `${name(row.uri)}:${row.line + 1}\n${row.source || ''}`;
      const cell = (value, className = '') => {
        const td = document.createElement('td');
        td.className = className;
        td.textContent = value || '';
        tr.append(td);
        return td;
      };
      const gutter = cell('', 'gutter');
      const controls = document.createElement('div');
      controls.className = 'gutter-content';
      let button;
      if (row.executable) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'breakpoint';
        button.textContent = '●';
        button.addEventListener('click', event => { event.stopPropagation(); send('breakpoint', index); });
        controls.append(button);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'breakpoint';
        controls.append(spacer);
      }
      const pc = document.createElement('span');
      pc.className = 'pc';
      pc.setAttribute('aria-hidden', 'true');
      controls.append(pc);
      gutter.append(controls);
      rendered.set(index, { element: tr, button, pc });
      const address = cell('', 'address');
      if (Number.isInteger(row.address)) {
        const link = document.createElement('button');
        link.type = 'button'; link.className = 'cell-link'; link.textContent = hex(row.address);
        link.title = t('Show this address in memory');
        link.addEventListener('click', event => { event.stopPropagation(); send('memory', index); });
        address.append(link);
      }
      const raw = document.createElement('span');
      raw.className = 'raw-hex';
      raw.textContent = row.bytes || '';
      raw.title = row.bytes || '';
      cell('').append(raw);
      if (typeof row.raw === 'string') cell(row.raw, 'source-raw').colSpan = 4;
      else if (!row.instruction && !row.label && row.comment) cell(row.comment, 'comment').colSpan = 4;
      else {
        cell(row.label, 'label');
        cell(row.instruction, 'instruction');
        const operand = document.createElement('span');
        operand.title = row.operand || '';
        let offset = 0;
        for (const match of (row.operand || '').matchAll(/(?<![\p{L}\p{N}_])[\p{L}_][\p{L}\p{N}_]*/gu)) {
          if (!row.operandSymbols?.includes(match[0])) continue;
          operand.append(document.createTextNode(row.operand.slice(offset, match.index)));
          const link = document.createElement('button');
          link.type = 'button'; link.className = 'cell-link'; link.textContent = match[0];
          link.title = t('Show definition: {0}', match[0]);
          link.addEventListener('click', event => { event.stopPropagation(); send('symbol', index, match[0]); });
          operand.append(link); offset = match.index + match[0].length;
        }
        operand.append(document.createTextNode((row.operand || '').slice(offset)));
        cell('', 'operand').append(operand);
        cell(row.comment, 'comment');
      }
      cell(row.nixbpe, 'flags');
      const bits = document.createElement('span');
      bits.textContent = row.rawCodeBinary || '';
      bits.title = bits.textContent + ((row.bytes || '').length > 64 ? ` (${t('{0} bytes total', row.bytes.length / 2)})` : '');
      cell('', 'binary').append(bits);
      cell(row.instructionBinary, 'instruction-binary');
      tr.addEventListener('click', () => selectRow(index));
      tr.addEventListener('dblclick', event => { if (!event.target.closest('button')) send('source', index); });
      tr.addEventListener('keydown', event => {
        if (event.target.closest('button')) return;
        if (event.key === 'Enter' || event.key === 'F12') { event.preventDefault(); event.stopPropagation(); if (selectedIndex >= 0) send('source', selectedIndex); }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          const selected = rendered.get(selectedIndex)?.element;
          const next = event.key === 'ArrowUp' ? selected?.previousElementSibling : selected?.nextElementSibling;
          if (next) { event.preventDefault(); selectRow(Number(next.dataset.index)); next.focus(); }
        }
      });
      fragment.append(tr);
    }
    body.append(fragment);
    byId('empty').hidden = body.children.length > 0;
    byId('empty').textContent = t("No source to display.");
    byId('open-source').disabled = selectedIndex < 0;
    updatePC();
    updateBreakpoints();
  }

  function renderFiles() {
    const uris = [...new Set([...sources.map(source => source.uri), ...fileRows.keys()])];
    if (!uris.includes(activeUri)) activeUri = uris[0] || '';
    const tabs = byId('file-tabs');
    tabs.replaceChildren();
    for (const uri of uris) {
      const tab = document.createElement('button');
      tab.type = 'button'; tab.role = 'tab'; tab.textContent = name(uri); tab.title = uri;
      tab.setAttribute('aria-selected', String(uri === activeUri));
      tab.tabIndex = uri === activeUri ? 0 : -1;
      tab.addEventListener('click', () => { activeUri = uri; remember(); renderFiles(); selectRow(selectedIndex); });
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? uris.length - 1 : (uris.indexOf(uri) + (event.key === 'ArrowLeft' ? -1 : 1) + uris.length) % uris.length;
        activeUri = uris[next]; remember(); renderFiles(); selectRow(selectedIndex); tabs.children[next].focus();
      });
      tabs.append(tab);
    }
    tabs.hidden = uris.length <= 1;
    byId('file-name').hidden = uris.length > 1;
    byId('file-name').textContent = name(activeUri);
    byId('file-name').title = activeUri;
    const hasFlags = rows.some(row => row.nixbpe);
    byId('flags-option').hidden = !hasFlags;
    byId('listing-table').classList.toggle('show-flags', hasFlags && flags.checked);
    remember();
    renderRows();
  }

  function showState(value, follow = false) {
    if (Number.isInteger(value.selectionVersion)) selectionVersion = value.selectionVersion;
    const previous = snapshot;
    snapshot = value;
    const labels = { paused: t("Paused"), running: t("Running"), halted: t("Halted"), failed: t("Execution failed"), terminated: t("Session ended") };
    byId('state').textContent = [labels[value.state] || '', Number.isInteger(value.pc) ? `PC ${hex(value.pc)}` : ''].filter(Boolean).join(' · ');
    const index = currentIndex();
    const active = ['running', 'paused', 'halted', 'failed'].includes(value.state);
    byId('state').disabled = !active;
    const changed = follow || previous.pc !== value.pc || previous.state !== value.state || previous.reason !== value.reason;
    if (active && changed && (follow || !value.selectedUri)) {
      const focused = document.hasFocus() && document.activeElement?.dataset.index !== undefined;
      const uri = rows[index]?.uri;
      const switched = !!uri && activeUri !== uri;
      if (switched) { activeUri = uri; renderFiles(); }
      selectRow(index, false);
      if (focused) rendered.get(index)?.element.focus({ preventScroll: true });
      if (follow || switched || previous.pc !== value.pc || previous.state !== value.state) rendered.get(index)?.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    updatePC();
  }

  byId('open-source').addEventListener('click', () => { if (selectedIndex >= 0) send('source', selectedIndex); });
  byId('state').addEventListener('click', () => send('pc'));
  flags.addEventListener('change', () => { remember(); byId('listing-table').classList.toggle('show-flags', flags.checked); });
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'listing') {
      const first = !rows.length || sessionId !== (message.sessionId || '') || revision !== message.revision;
      revision = message.revision;
      selectionVersion = message.selectionVersion;
      if (first) { sessionId = message.sessionId || ''; selectedIndex = -1; }
      rows = Array.isArray(message.rows) ? message.rows : [];
      fileRows = new Map();
      pcRows = new Map();
      rows.forEach((row, index) => {
        if (!fileRows.has(row.uri)) fileRows.set(row.uri, []);
        fileRows.get(row.uri).push(index);
        if (row.executable && !pcRows.has(row.address)) pcRows.set(row.address, index);
      });
      sources = Array.isArray(message.sources) ? message.sources : [];
      if (sources.some(source => source.uri === message.selectedUri)) activeUri = message.selectedUri;
      breakpointKeys = new Set((Array.isArray(message.breakpoints) ? message.breakpoints : []).map(breakpointKey));
      byId('error').hidden = true;
      renderFiles();
      const state = { ...snapshot, selectedUri: message.selectedUri, selectionVersion };
      if (first) snapshot = {};
      showState(state);
      if (Number.isInteger(message.selectedIndex) && message.selectedIndex >= 0) reveal(message.selectedIndex);
    } else if (message.type === 'state') showState(message, message.follow === true);
    else if (message.type === 'reveal') reveal(message.index);
    else if (message.type === 'breakpoints') { breakpointKeys = new Set((message.breakpoints || []).map(breakpointKey)); updateBreakpoints(); }
    else if (message.type === 'error') { byId('error').textContent = message.message || t("The listing could not be displayed."); byId('error').hidden = false; }
  });
  vscode.postMessage({ type: 'ready' });
})();

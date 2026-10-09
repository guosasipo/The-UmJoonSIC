// Prepare immutable symbol names once per assembly, including section disambiguation.
function prepareMemorySymbols(symbols) {
  const valid = symbols.filter(symbol => typeof symbol.name === 'string' && symbol.name && Number.isSafeInteger(symbol.address) && symbol.address >= 0 && Number.isSafeInteger(symbol.size) && symbol.size > 0);
  const sections = new Map();
  for (const symbol of valid) {
    if (!sections.has(symbol.name)) sections.set(symbol.name, new Set());
    sections.get(symbol.name).add(symbol.section || '');
  }
  return valid.map(symbol => ({ ...symbol,
    displayName: sections.get(symbol.name).size > 1 && symbol.section ? `${symbol.section}::${symbol.name}` : symbol.name,
  })).sort((a, b) => a.address - b.address);
}

// Clip already prepared page symbols; overlapping ranges use separate label lanes.
function memorySymbolLanes(symbols, rowAddress, rowLength, pageAddress) {
  const segments = [];
  for (const symbol of symbols) {
    if (symbol.address >= rowAddress + rowLength) break;
    const first = Math.max(rowAddress, symbol.address);
    const last = Math.min(rowAddress + rowLength, symbol.address + symbol.size);
    if (first >= last) continue;
    segments.push({
      start: first - rowAddress, span: last - first, name: symbol.displayName,
      label: first === Math.max(pageAddress, symbol.address) ? symbol.displayName : '',
      address: symbol.address, size: symbol.size,
      continuesLeft: first > symbol.address, continuesRight: last < symbol.address + symbol.size,
    });
  }
  segments.sort((a, b) => a.start - b.start || b.span - a.span || a.name.localeCompare(b.name));
  const lanes = [];
  for (const segment of segments) {
    let lane = lanes.find(items => items.at(-1).start + items.at(-1).span <= segment.start);
    if (!lane) lanes.push(lane = []);
    lane.push(segment);
  }
  return lanes;
}

(() => {
  'use strict';
  const api = acquireVsCodeApi();
  const t = globalThis.umjoonsicL10n.t;
  const byId = id => document.getElementById(id);
  const addressInput = byId('address');
  const countInput = byId('count');
  const memoryBody = byId('memory-body');
  const registerNames = ['A', 'X', 'L', 'B', 'S', 'T', 'SW', 'PC', 'F'];
  const controls = [...document.querySelectorAll('[data-action]')];
  const saved = api.getState() || {};
  let hexMode = saved.hexMode !== false;
  let sessionId = '';
  let connected = false;
  let mode = 'sic';
  let snapshot;
  let previousRegisters;
  let memory;
  let previousBytes = new Map();
  let cells = new Map();
  let addressEdited = false;
  let initialMemory = true;
  let copyText = '';
  let symbols = [], symbolVersion = 0, pcAddress;
  let devices;
  let pendingDevice;
  let targetAddress;
  byId('device-format').value = saved.deviceFormat === 'text' ? 'text' : 'hex';
  byId('devices-panel').open = saved.devicesExpanded !== false;

  const capacity = () => mode === 'sicxe' ? 1048576 : 32768;
  const hex = (value, width = 6) => `0x${value.toString(16).toUpperCase().padStart(width, '0')}`;
  const signed24 = value => (value & 0xFFFFFF) >= 0x800000 ? (value & 0xFFFFFF) - 0x1000000 : value & 0xFFFFFF;
  const hasMachine = () => connected && !!snapshot;

  function error(message = '') {
    byId('error').textContent = message;
    byId('error').hidden = !message;
  }

  function registerValue(name, registers) {
    if (!registers) return '—';
    if (name === 'F') {
      if (hexMode) return typeof registers.FHex === 'string' ? `0x${registers.FHex.replace(/^0x/i, '').toUpperCase().padStart(12, '0')}` : '—';
      return typeof registers.F === 'string' ? registers.F : '—';
    }
    const value = registers[name];
    if (!Number.isFinite(value)) return '—';
    if (hexMode) return hex(value & 0xFFFFFF);
    return String(name === 'PC' || name === 'SW' ? value : signed24(value));
  }

  function renderRegisters(markChanges = true) {
    const toggle = byId('hex-toggle');
    toggle.setAttribute('aria-pressed', String(hexMode));
    toggle.setAttribute('aria-label', hexMode ? t("Hexadecimal enabled; switch to decimal") : t("Decimal enabled; switch to hexadecimal"));
    const registers = snapshot?.registers;
    const valuesChanged = !registers || !previousRegisters || registerNames.some(name => registers[name] !== previousRegisters[name]) || registers.FHex !== previousRegisters.FHex;
    for (const name of registerNames) {
      const output = byId(`value-${name}`);
      output.textContent = registerValue(name, registers);
      output.title = `${name}: ${output.textContent}`;
      if (markChanges && valuesChanged) {
        byId(`register-${name}`).classList.toggle('changed', !!registers && !!previousRegisters && registers[name] !== previousRegisters[name]);
      }
    }
    if (markChanges && valuesChanged) previousRegisters = registers ? { ...registers } : undefined;
  }

  function renderControls() {
    const running = connected && snapshot?.state === 'running';
    const paused = connected && snapshot?.state === 'paused';
    for (const button of controls) {
      const action = button.dataset.action;
      if (action === 'run' || action === 'debug') { button.hidden = connected; button.disabled = connected; }
      else if (action === 'assemble') button.disabled = connected;
      else if (action === 'continue') { button.hidden = !connected || running; button.disabled = !paused; }
      else if (action === 'pause') { button.hidden = !running; button.disabled = !running; }
      else if (['stepIn', 'next', 'stepOut'].includes(action)) button.disabled = !paused;
      else if (action === 'restart' || action === 'stop') button.disabled = !connected;
    }
    addressInput.disabled = !hasMachine();
    countInput.disabled = !hasMachine();
    byId('read-memory').disabled = !hasMachine();
    byId('previous').disabled = !hasMachine() || !memory || memory.address <= 0;
    byId('following').disabled = !hasMachine() || !memory || memory.address + Number(countInput.value) >= capacity();
    byId('copy-memory').disabled = !copyText;
    byId('last-write').disabled = !connected || !snapshot?.lastWrite;
    byId('state').disabled = !hasMachine();
    const selectedDevice = pendingDevice === undefined && devices?.detail?.index === Number(byId('device-select').value);
    byId('device-reset').disabled = !connected || running || !selectedDevice || !devices?.detail?.filename;
    byId('device-open').disabled = !selectedDevice || !devices?.detail?.filename;
    byId('device-refresh').disabled = !connected || pendingDevice !== undefined;
    byId('copy-device-read').disabled = !selectedDevice || !devices?.detail?.read;
    byId('copy-device-write').disabled = !selectedDevice || !devices?.detail?.written;
  }

  function clearMemory() {
    memory = undefined;
    previousBytes = new Map();
    cells = new Map();
    pcAddress = undefined;
    copyText = '';
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 10;
    cell.className = 'empty';
    cell.textContent = t("Memory appears after launching.");
    row.append(cell);
    memoryBody.replaceChildren(row);
    byId('memory-range').textContent = '—';
  }

  function updatePC() {
    const pc = snapshot?.pc ?? memory?.pc;
    if (pcAddress === pc) return;
    const previous = cells.get(pcAddress);
    if (previous) {
      previous.cell.classList.remove('pc');
      previous.cell.title = previous.description;
      previous.cell.setAttribute('aria-label', previous.description);
    }
    const current = cells.get(pc);
    if (current) {
      current.cell.classList.add('pc');
      current.cell.title = `${current.description} · PC`;
      current.cell.setAttribute('aria-label', current.cell.title);
    }
    pcAddress = pc;
  }

  function renderMemory(data) {
    const normalizedBytes = data.bytes.toUpperCase();
    const bytes = normalizedBytes.match(/../g) || [];
    if (memory?.address === data.address && memory.bytes === normalizedBytes && memory.symbolVersion === symbolVersion) {
      memory.pc = data.pc;
      updatePC();
      renderControls();
      return;
    }
    const pageSymbols = symbols.filter(symbol => symbol.address < data.address + bytes.length && symbol.address + symbol.size > data.address);
    const fragment = document.createDocumentFragment();
    const nextBytes = new Map();
    const nextCells = new Map();
    for (let index = 0; index < bytes.length; index += 8) {
      const row = document.createElement('tr');
      row.className = `byte-row${index % 16 ? ' alternate' : ''}`;
      const lanes = memorySymbolLanes(pageSymbols, data.address + index, Math.min(8, bytes.length - index), data.address);
      const segments = lanes.flat();
      const label = document.createElement('th');
      label.scope = 'row';
      label.textContent = (data.address + index).toString(16).toUpperCase().padStart(6, '0');
      row.append(label);
      let ascii = '';
      for (let column = 0; column < 8; column++) {
        const cell = document.createElement('td');
        const byte = bytes[index + column];
        const address = data.address + index + column;
        cell.textContent = byte || '';
        if (byte !== undefined) {
          nextBytes.set(address, byte);
          cell.classList.toggle('changed', previousBytes.has(address) && previousBytes.get(address) !== byte);
          const names = segments.filter(segment => column >= segment.start && column < segment.start + segment.span).map(segment => segment.name);
          cell.classList.toggle('symbol', names.length > 0);
          const description = `${hex(address)}: ${byte}${names.length ? ` · ${names.join(', ')}` : ''}`;
          cell.title = description;
          cell.setAttribute('aria-label', description);
          cell.classList.toggle('target', address === targetAddress);
          cell.tabIndex = 0;
          cell.addEventListener('dblclick', () => api.postMessage({ type: 'navigate', address }));
          cell.addEventListener('keydown', event => { if (event.key === 'Enter') api.postMessage({ type: 'navigate', address }); });
          nextCells.set(address, { cell, description });
          const value = parseInt(byte, 16);
          ascii += value >= 32 && value < 127 ? String.fromCharCode(value) : '.';
        }
        row.append(cell);
      }
      const characters = document.createElement('td');
      characters.className = 'ascii';
      characters.textContent = ascii;
      row.append(characters);
      fragment.append(row);
      for (const lane of lanes) {
        const ranges = document.createElement('tr');
        ranges.className = 'symbol-row';
        const addressGap = document.createElement('td');
        addressGap.setAttribute('aria-hidden', 'true');
        ranges.append(addressGap);
        let column = 0;
        for (const segment of lane) {
          if (segment.start > column) {
            const gap = document.createElement('td');
            gap.colSpan = segment.start - column;
            gap.setAttribute('aria-hidden', 'true');
            ranges.append(gap);
          }
          const cell = document.createElement('td');
          cell.colSpan = segment.span;
          cell.className = 'symbol-cell';
          cell.title = `${segment.name} · ${hex(segment.address)}–${hex(segment.address + segment.size - 1)} · ${segment.size} B`;
          cell.setAttribute('aria-label', cell.title);
          cell.tabIndex = 0;
          cell.addEventListener('dblclick', () => api.postMessage({ type: 'navigate', address: segment.address, source: true }));
          cell.addEventListener('keydown', event => { if (event.key === 'Enter') api.postMessage({ type: 'navigate', address: segment.address, source: true }); });
          const bracket = document.createElement('div');
          bracket.className = `symbol-bracket${segment.continuesLeft ? ' continues-left' : ''}${segment.continuesRight ? ' continues-right' : ''}`;
          if (segment.label) {
            const name = document.createElement('span');
            name.className = 'symbol-name';
            name.textContent = segment.label;
            bracket.append(name);
          }
          cell.append(bracket);
          ranges.append(cell);
          column = segment.start + segment.span;
        }
        if (column < 8) {
          const gap = document.createElement('td');
          gap.colSpan = 8 - column;
          gap.setAttribute('aria-hidden', 'true');
          ranges.append(gap);
        }
        const asciiGap = document.createElement('td');
        asciiGap.className = 'ascii';
        asciiGap.setAttribute('aria-hidden', 'true');
        ranges.append(asciiGap);
        fragment.append(ranges);
      }
    }
    memory = { address: data.address, pc: data.pc, bytes: normalizedBytes, symbolVersion };
    previousBytes = nextBytes;
    cells = nextCells;
    pcAddress = undefined;
    copyText = bytes.join(' ');
    memoryBody.replaceChildren(fragment);
    byId('memory-range').textContent = bytes.length ? `${hex(data.address)}–${hex(data.address + bytes.length - 1)} · ${bytes.length} B` : '0 B';
    updatePC();
    renderControls();
  }

  function requestMemory(address = addressInput.value.trim()) {
    if (!hasMachine()) return;
    if (!address) {
      error(t('Enter a hexadecimal address or symbol, for example 0x1000 or RESULT.'));
      addressInput.focus();
      return;
    }
    error();
    api.postMessage({ type: 'read', address, count: Number(countInput.value) });
  }

  function page(direction) {
    if (!memory || !hasMachine()) return;
    const count = Number(countInput.value);
    const address = Math.max(0, Math.min(capacity() - count, memory.address + direction * count));
    addressInput.value = hex(address);
    addressEdited = true;
    requestMemory(addressInput.value);
  }

  function byteText(bytes, copy = false) {
    const values = bytes.match(/../g) || [];
    if (byId('device-format').value !== 'text') return values.join(' ');
    return values.map(byte => {
      const value = parseInt(byte, 16);
      if (value >= 32 && value < 127 || copy && value === 9) return String.fromCharCode(value);
      if (value === 10) return copy ? '\n' : '↵\n';
      if (value === 0 && !copy) return '␀';
      return `\\x${byte}`;
    }).join('');
  }

  function renderDevices(data) {
    if (pendingDevice !== undefined && data.selected !== pendingDevice && data.devices.some(device => device.index === pendingDevice)) return;
    pendingDevice = undefined;
    devices = data;
    const panel = byId('devices-panel'), select = byId('device-select');
    panel.hidden = !data.devices.length;
    const options = data.devices.map(device => `${device.index}:${device.filename || ''}`).join('\n');
    if (select.dataset.options !== options) {
      select.replaceChildren(...data.devices.map(device => {
        const option = document.createElement('option');
        option.value = String(device.index); option.textContent = hex(device.index, 2);
        option.title = device.filename || t('Not connected');
        return option;
      }));
      select.dataset.options = options;
    }
    select.value = String(data.selected);
    const detail = data.detail;
    if (!detail) {
      for (const id of ['device-read', 'device-write', 'device-input', 'device-status']) byId(id).replaceChildren();
      byId('device-input-group').hidden = true;
      byId('copy-device-read').disabled = byId('copy-device-write').disabled = true;
      renderControls();
      return;
    }
    const status = [detail.filename || t('Not connected'), t('Read {0} · Written {1} · TD {2}', detail.readCount, detail.writtenCount, detail.tests)];
    if (detail.eof) status.push('EOF');
    if (detail.notReady) status.push(t('Not ready: {0}', detail.notReady));
    if (detail.readCount > (detail.read || '').length / 2 || detail.writtenCount > (detail.written || '').length / 2) status.push(t('Showing recent bytes'));
    byId('device-status').textContent = status.join(' · ');
    byId('device-status').title = detail.filename || '';
    for (const [id, bytes] of [['device-read', detail.read], ['device-write', detail.written]]) {
      const node = byId(id), text = byteText(bytes || '');
      node.classList.toggle('changed', node.textContent !== text && !!node.textContent);
      node.textContent = text || '—';
    }
    byId('device-write-heading').textContent = detail.filename ? t('Written') : t('Discarded');
    byId('copy-device-read').disabled = !detail.read;
    byId('copy-device-write').disabled = !detail.written;
    byId('device-input-group').hidden = !detail.input;
    const input = byId('device-input'); input.replaceChildren();
    if (detail.input) {
      const preview = detail.input;
      input.title = preview.error || t('File position {0} of {1}', detail.position, preview.length);
      const bytes = (preview.bytes || '').match(/../g) || [];
      for (const [offset, byte] of bytes.slice(0, 128).entries()) {
        const cell = document.createElement('span');
        cell.textContent = byId('device-format').value === 'hex' ? `${byte} ` : byteText(byte);
        cell.title = `${hex(preview.address + offset)}: ${byte}`;
        cell.classList.toggle('cursor', preview.address + offset === detail.position);
        input.append(cell);
      }
      if (!bytes.length) input.textContent = preview.error || (detail.position >= preview.length ? 'EOF' : '—');
    }
    renderControls();
  }

  for (const button of controls) {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      error();
      api.postMessage({ type: 'control', action: button.dataset.action });
    });
  }
  byId('hex-toggle').addEventListener('click', () => {
    hexMode = !hexMode;
    api.setState({ ...api.getState(), hexMode });
    renderRegisters(false);
  });
  addressInput.addEventListener('input', () => { addressEdited = true; });
  byId('memory-form').addEventListener('submit', event => { event.preventDefault(); requestMemory(); });
  countInput.addEventListener('change', () => { requestMemory(); renderControls(); });
  byId('previous').addEventListener('click', () => page(-1));
  byId('following').addEventListener('click', () => page(1));
  byId('copy-memory').addEventListener('click', () => { if (copyText) api.postMessage({ type: 'copy', text: copyText }); });
  byId('last-write').addEventListener('click', () => api.postMessage({ type: 'lastWrite' }));
  byId('state').addEventListener('click', () => api.postMessage({ type: 'pc' }));
  byId('delay-presets').addEventListener('change', event => {
    if (event.target.value === 'custom') api.postMessage({ type: 'control', action: 'delay' });
    else api.postMessage({ type: 'delayPreset', value: Number(event.target.value) });
  });
  function requestDevice() {
    pendingDevice = Number(byId('device-select').value);
    renderControls();
    byId('copy-device-read').disabled = byId('copy-device-write').disabled = true;
    api.postMessage({ type: 'device', index: pendingDevice, sessionId });
  }
  byId('device-select').addEventListener('change', requestDevice);
  byId('device-refresh').addEventListener('click', requestDevice);
  byId('device-format').addEventListener('change', event => { api.setState({ ...api.getState(), deviceFormat: event.target.value }); if (devices) renderDevices(devices); });
  byId('devices-panel').addEventListener('toggle', event => api.setState({ ...api.getState(), devicesExpanded: event.target.open }));
  byId('device-open').addEventListener('click', () => api.postMessage({ type: 'deviceOpen', index: Number(byId('device-select').value), sessionId }));
  byId('device-reset').addEventListener('click', () => api.postMessage({ type: 'deviceReset', index: Number(byId('device-select').value), sessionId }));
  byId('copy-device-read').addEventListener('click', () => { if (devices?.detail?.read) api.postMessage({ type: 'copy', text: byteText(devices.detail.read, true) }); });
  byId('copy-device-write').addEventListener('click', () => { if (devices?.detail?.written) api.postMessage({ type: 'copy', text: byteText(devices.detail.written, true) }); });

  window.addEventListener('message', ({ data }) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'error') { pendingDevice = undefined; renderControls(); error(typeof data.message === 'string' ? data.message : t("The request could not be completed.")); return; }
    if (data.type === 'state') {
      const nextId = typeof data.sessionId === 'string' ? data.sessionId : '';
      const newSession = nextId !== sessionId;
      if (newSession) {
        sessionId = nextId;
        symbols = [];
        symbolVersion++;
        clearMemory();
        initialMemory = true;
        addressEdited = false;
        addressInput.value = '0x000000';
        previousRegisters = undefined;
        targetAddress = undefined;
        devices = undefined;
        pendingDevice = undefined;
        byId('devices-panel').hidden = true;
        error();
      }
      connected = data.connected === true;
      if (!connected) pendingDevice = undefined;
      mode = data.mode === 'sicxe' ? 'sicxe' : 'sic';
      if (snapshot?.stepCount !== data.snapshot?.stepCount) document.querySelectorAll('.changed').forEach(node => node.classList.remove('changed'));
      snapshot = data.snapshot && typeof data.snapshot === 'object' && data.snapshot.registers ? data.snapshot : undefined;
      byId('mode').textContent = mode === 'sicxe' ? 'SIC / XE' : 'SIC';
      const title = typeof data.title === 'string' && data.title ? data.title : t("Select a source to run");
      byId('session-title').textContent = title;
      byId('session-title').title = title;
      const state = byId('state');
      state.className = 'state-label';
      if (!connected) state.textContent = snapshot ? t("Session ended") : t("Idle");
      else {
        state.textContent = ({ paused: t("Paused"), running: t("Running"), halted: t("Halted"), failed: t("Error") })[snapshot?.state] || t("Loading");
        if (snapshot?.state === 'running' || snapshot?.state === 'failed') state.classList.add(snapshot.state);
      }
      if (Number.isInteger(data.delayMs)) byId('delay').textContent = [0, 100, 250, 500, 1000].includes(data.delayMs) ? '' : `${data.delayMs} ms`;
      if (Number.isInteger(data.delayMs)) byId('delay-presets').value = [0, 100, 250, 500, 1000].includes(data.delayMs) ? String(data.delayMs) : 'custom';
      byId('statistics').textContent = snapshot?.stepCount === undefined ? '' : t('{0} instructions · {1}/s', snapshot.stepCount.toLocaleString(), Math.round(snapshot.rate || 0).toLocaleString());
      byId('last-write').title = snapshot?.lastWrite ? t('Last write: {0} · {1} bytes', hex(snapshot.lastWrite.address), snapshot.lastWrite.size) : t('Show last memory write');
      const detail = byId('detail');
      detail.textContent = snapshot?.state === 'failed' && typeof snapshot.message === 'string' ? snapshot.message : '';
      detail.hidden = !detail.textContent;
      detail.classList.toggle('failed', snapshot?.state === 'failed');
      renderRegisters();
      renderControls();
      updatePC();
    } else if (data.type === 'symbols') {
      if (data.sessionId !== sessionId || !Array.isArray(data.symbols)) return;
      symbols = prepareMemorySymbols(data.symbols);
      symbolVersion++;
      if (memory) renderMemory(memory);
    } else if (data.type === 'memory') {
      if (data.sessionId !== sessionId || !Number.isInteger(data.address) || typeof data.bytes !== 'string' || data.bytes.length > 8192 || !/^(?:[0-9a-f]{2})*$/i.test(data.bytes)) return;
      if (initialMemory) {
        if (!addressEdited && document.activeElement !== addressInput) addressInput.value = hex(data.address);
        if ([128, 256, 512, 1024, 4096].includes(data.count)) countInput.value = String(data.count);
        initialMemory = false;
      }
      renderMemory(data);
    } else if (data.type === 'devices' && data.sessionId === sessionId && Array.isArray(data.devices)) {
      renderDevices(data);
    } else if (data.type === 'address' && Number.isSafeInteger(data.address) && data.address >= 0 && data.address < capacity()) {
      addressInput.value = hex(data.address);
      addressEdited = true;
      memoryBody.querySelectorAll('.target').forEach(node => node.classList.remove('target'));
      targetAddress = data.target;
      const cell = cells.get(targetAddress)?.cell;
      cell?.classList.add('target');
      cell?.scrollIntoView({ block: 'nearest' });
    }
  });

  renderRegisters();
  renderControls();
  api.postMessage({ type: 'ready' });
})();

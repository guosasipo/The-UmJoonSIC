(() => {
  'use strict';
  const api = acquireVsCodeApi();
  const t = globalThis.umjoonsicL10n.t;
  const $ = id => document.getElementById(id);
  const form = $('settings-form'), main = $('main-section'), mode = $('mode'), delay = $('step-delay');
  const sourcePath = $('source-path'), deviceIndex = $('device-index');
  const pending = new Map();
  let current, sourceKey = '', deviceKey = '', draggedPath, dropBefore, dropRow, pendingMove;
  const send = message => api.postMessage(message);
  const hex = index => `0x${index.toString(16).toUpperCase().padStart(2, '0')}`;
  const edit = change => {
    $('error').hidden = true;
    $('save-status').textContent = t('Unsaved changes');
    $('save-status').classList.add('dirty');
    send({ type: 'edit', change });
  };
  function editField(type, value) { pending.set(type, value); edit({ type, value }); }
  function updateField(input, type, value, force) {
    if (force || pending.get(type) === value) pending.delete(type);
    if ((force || !pending.has(type)) && input.value !== String(value)) input.value = String(value);
  }
  function options(id, values) {
    const list = $(id);
    if (JSON.stringify(values) === list.dataset.values) return;
    list.dataset.values = JSON.stringify(values);
    list.replaceChildren(...values.map(value => {
      const option = document.createElement('option');
      option.value = value;
      return option;
    }));
  }
  function button(text, label, action, disabled = false) {
    const node = document.createElement('button');
    node.type = 'button'; node.className = 'secondary'; node.textContent = text;
    node.title = label; node.setAttribute('aria-label', label); node.disabled = disabled;
    node.addEventListener('click', action);
    return node;
  }
  function badge(label, warning = false) {
    const node = document.createElement('span');
    node.className = warning ? 'badge warning' : 'badge';
    node.textContent = label;
    return node;
  }
  function row(number, filename, device) {
    const item = document.createElement('li'); item.className = 'file-row';
    const index = document.createElement('span'); index.className = device ? 'device-number' : 'file-number'; index.textContent = number;
    const file = document.createElement('span'); file.className = 'file-path'; file.textContent = filename; file.title = filename;
    const actions = document.createElement('div'); actions.className = 'row-actions';
    item.append(index, file, actions);
    return { item, file, actions };
  }
  function replaceRows(list, rows) {
    const focusedLabel = list.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
    list.replaceChildren(...rows);
    if (focusedLabel) {
      const buttons = [...list.querySelectorAll('button:not(:disabled)')];
      (buttons.find(node => node.getAttribute('aria-label') === focusedLabel) ?? buttons[0])?.focus();
    }
  }
  function moveSource(path, direction) {
    pendingMove = { path, from: current.data.asm.indexOf(path) };
    edit({ type: 'moveSource', path, direction });
  }
  function clearDrop() {
    dropRow?.classList.remove('drop-before', 'drop-after');
    dropRow = undefined; dropBefore = undefined;
  }
  function showSources(data, sections, missing) {
    const sources = data.asm, mainName = data.main ?? '';
    const mainFile = mainName.trim() ? sources.find(path => sections[path]?.includes(mainName)) : sources[0];
    const unknownMain = !!mainName.trim() && sources.length > 0 && !mainFile && sources.every(path => Object.hasOwn(sections, path) || missing.includes(path));
    $('main-warning').hidden = !unknownMain;
    $('main-warning').textContent = unknownMain ? t('No source defines the main program "{0}".', mainName) : '';
    const key = JSON.stringify([sources, mainFile, missing]);
    if (key === sourceKey) return;
    sourceKey = key;
    if (pendingMove && sources.includes(pendingMove.path) && sources.indexOf(pendingMove.path) !== pendingMove.from) {
      $('order-status').textContent = t('{0} moved to position {1} of {2}.', pendingMove.path, sources.indexOf(pendingMove.path) + 1, sources.length);
      pendingMove = undefined;
    }
    replaceRows($('source-list'), sources.map((path, index) => {
      const { item, file, actions } = row(String(index + 1), path, false);
      item.dataset.path = path;
      const handle = button('↕', t('{0}: drag to reorder, or press Alt+Up / Alt+Down.', path), () => {});
      handle.classList.add('drag-handle'); handle.draggable = true;
      handle.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
      handle.addEventListener('dragstart', event => {
        draggedPath = path; item.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', path);
      });
      handle.addEventListener('dragend', () => { draggedPath = undefined; item.classList.remove('dragging'); clearDrop(); });
      handle.addEventListener('keydown', event => {
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const direction = event.key === 'ArrowUp' ? -1 : 1;
        if (index + direction >= 0 && index + direction < sources.length) moveSource(path, direction);
      });
      item.prepend(handle);
      if (path === mainFile) file.after(badge(t('Main')));
      if (missing.includes(path)) file.after(badge(t('File unavailable'), true));
      actions.append(
        button('↑', t('{0}: move up one position.', path), () => moveSource(path, -1), index === 0),
        button('↓', t('{0}: move down one position.', path), () => moveSource(path, 1), index === sources.length - 1),
        button(t('Remove'), t('{0}: remove from the list. The file is kept.', path), () => edit({ type: 'removeSource', path })),
      );
      return item;
    }));
    $('sources-empty').hidden = sources.length > 0;
    $('source-count').textContent = String(sources.length);
  }
  $('source-list').addEventListener('dragover', event => {
    const item = event.target.closest('li[data-path]');
    if (!draggedPath || !item) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    const bounds = item.getBoundingClientRect(), after = event.clientY > bounds.top + bounds.height / 2;
    clearDrop(); dropRow = item;
    dropBefore = after ? item.nextElementSibling?.dataset.path : item.dataset.path;
    item.classList.add(after ? 'drop-after' : 'drop-before');
  });
  $('source-list').addEventListener('dragleave', event => { if (!event.currentTarget.contains(event.relatedTarget)) clearDrop(); });
  $('source-list').addEventListener('drop', event => {
    if (!draggedPath || !dropRow) return;
    event.preventDefault();
    if (draggedPath !== dropBefore) { pendingMove = { path: draggedPath, from: current.data.asm.indexOf(draggedPath) }; edit({ type: 'reorderSource', path: draggedPath, before: dropBefore }); }
    draggedPath = undefined; clearDrop();
  });
  function showDevices(devices, usage, paths) {
    const rows = new Map(usage.map(device => [device.index, { ...device, filename: undefined }]));
    for (const device of devices) rows.set(device.index, { ...rows.get(device.index), ...device });
    const values = [...rows.values()].sort((a, b) => a.index - b.index);
    const key = JSON.stringify([values, paths]);
    if (key !== deviceKey) {
      deviceKey = key;
      replaceRows($('device-list'), values.map(device => {
        const { index, filename, labels = [] } = device;
        const { item, file, actions } = row(hex(index), filename ?? t('Not connected'), true);
        item.dataset.device = String(index);
        if (!filename) file.classList.add('warning');
        const use = document.createElement('span'); use.className = 'device-use';
        use.textContent = device.read && device.write ? t('Read / write') : device.read ? t('Read') : device.write ? t('Write') : device.test ? t('Test') : t('Not detected');
        use.title = labels.join(', '); if (labels.length) use.textContent += ` · ${labels[0]}`;
        file.before(use);
        if (filename && paths[index]?.usable === false) file.after(badge(t('Unusable path'), true));
        else if (filename && paths[index]?.exists === false) file.after(badge(t('File will be created')));
        if (filename) actions.append(
          button(t('Open'), t('{0}: open the connected file.', hex(index)), () => send({ type: 'openDevice', index }), !paths[index]?.exists),
          button(t('Change…'), t('{0}: choose a different file.', hex(index)), () => send({ type: 'pickDevice', index })),
          button(t('Disconnect'), t('{0}: disconnect the device. The file is kept.', hex(index)), () => edit({ type: 'removeDevice', index })),
        );
        else actions.append(
          button(t('New file'), t('{0}: create and connect a new device file.', hex(index)), () => send({ type: 'newDevice', index })),
          button(t('Connect…'), t('{0}: choose a device file.', hex(index)), () => send({ type: 'pickDevice', index })),
        );
        return item;
      }));
      $('devices-empty').hidden = values.length > 0;
      $('device-count').textContent = String(values.length);
    }
    const mapped = devices.find(device => device.index === Number(deviceIndex.value));
    $('device-help').textContent = mapped ? t('Connected: {0}. Choosing a file changes this connection.', mapped.filename) : '';
  }
  function addSource() {
    const path = sourcePath.value.trim();
    sourcePath.setCustomValidity(path && !/\.asm$/i.test(path) ? t('Enter an .asm file path.') : path ? '' : t('Enter an .asm file to add.'));
    if (!sourcePath.reportValidity()) return;
    edit({ type: 'addSource', path }); sourcePath.value = ''; sourcePath.focus();
  }
  function save() {
    sourcePath.setCustomValidity('');
    if ($('settings').disabled || !form.reportValidity()) return;
    send({ type: 'save' });
  }
  for (let index = 0; index < 256; index++) {
    const option = document.createElement('option'); option.value = String(index); option.textContent = hex(index); deviceIndex.append(option);
  }
  main.addEventListener('input', () => editField('main', main.value));
  mode.addEventListener('change', () => editField('mode', mode.value));
  delay.addEventListener('input', () => { if (delay.checkValidity()) editField('delay', delay.valueAsNumber); else pending.set('delay', delay.value); });
  sourcePath.addEventListener('input', () => sourcePath.setCustomValidity(''));
  sourcePath.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addSource(); } });
  $('add-source').addEventListener('click', addSource);
  $('pick-sources').addEventListener('click', () => send({ type: 'pickSources' }));
  $('pick-device').addEventListener('click', () => send({ type: 'pickDevice', index: Number(deviceIndex.value) }));
  $('new-device').addEventListener('click', () => send({ type: 'newDevice', index: Number(deviceIndex.value) }));
  deviceIndex.addEventListener('change', () => showDevices(current?.data?.filedevices ?? [], current?.deviceUsage ?? [], current?.devicePaths ?? {}));
  $('open-text').addEventListener('click', () => send({ type: 'openText' }));
  form.addEventListener('submit', event => { event.preventDefault(); save(); });
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return;
    const key = event.key.toLowerCase();
    if (key === 's' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); save(); }
    else if (key === 'z' || (key === 'y' && !event.shiftKey)) {
      if (event.target === sourcePath || event.target === deviceIndex) return;
      event.preventDefault(); event.stopPropagation(); send({ type: key === 'y' || event.shiftKey ? 'redo' : 'undo' });
    }
  });
  window.addEventListener('message', ({ data: message }) => {
    if (!message || message.type !== 'state') return;
    current = message;
    $('file-name').textContent = message.fileName.split(/[\\/]/).pop() || message.fileName;
    $('file-name').title = message.fileName;
    $('error').textContent = message.error || ''; $('error').hidden = !message.error;
    if (message.error || message.force) pendingMove = undefined;
    $('settings').disabled = !message.data; $('save').disabled = !message.data; $('invalid-actions').hidden = !!message.data;
    if (!message.data) { $('save-status').textContent = t('Check project settings'); $('save-status').classList.remove('dirty'); return; }
    updateField(main, 'main', message.data.main ?? '', message.force);
    updateField(mode, 'mode', message.mode, message.force);
    updateField(delay, 'delay', message.stepDelayMs, message.force);
    const dirty = message.dirty || pending.size > 0;
    $('save-status').textContent = dirty ? t('Unsaved changes') : t('Saved'); $('save-status').classList.toggle('dirty', dirty);
    $('save-help').textContent = message.autoSave ? t('Auto Save follows VS Code settings.') : t('Save changes before running the project.');
    options('main-candidates', message.mainCandidates);
    options('source-candidates', message.candidates.filter(path => !message.data.asm.includes(path)));
    showSources(message.data, message.sections ?? {}, message.missingSources ?? []);
    showDevices(message.data.filedevices ?? [], message.deviceUsage ?? [], message.devicePaths ?? {});
  });
  send({ type: 'ready' });
})();

import * as vscode from 'vscode';
import { debugViewHtml } from './debugViewHtml';
import { listingHtml } from './listingHtml';
import { buildListingRows, resolveListingSymbol, type DisplayListingRow } from './listingModel';
import { currentFolder } from './projects';
import { getProject, refreshProjects } from './projectFiles';
import { sourceFileKey } from './sourceFiles';
import type { AssemblyResult, Snapshot, Source, DeviceResult, DeviceState } from './protocol';

const uriKey = (uri: vscode.Uri) => process.platform === 'win32' ? uri.toString().toLowerCase() : uri.toString();

export class Views implements vscode.WebviewViewProvider, vscode.Disposable {
  private assembly?: AssemblyResult;
  private snapshot?: Snapshot;
  private listing?: vscode.WebviewPanel;
  private listingRows: DisplayListingRow[] = [];
  private sources: Source[] = [];
  private sourceKeys = Promise.resolve(new Map<string, string>());
  private sourceAliases = new Map<string, string>();
  private breakpointRequest = 0;
  private view?: vscode.WebviewView;
  private session?: vscode.DebugSession;
  private memory?: Record<string, unknown>;
  private title = 'UmJoonSIC';
  private lastMode: 'sic' | 'sicxe' = 'sic';
  private lastDelay = 250;
  private lastFolder?: vscode.WorkspaceFolder;
  private address = 0;
  private count = 256;
  private generation = 0;
  private sessionId = '';
  private lastState = '';
  private memoryUpdate?: Promise<void>;
  private memoryAgain = false;
  private sourceRequest = 0;
  private selectedListingRow = -1;
  private selectedListingUri?: string;
  // Resume/pause must expire old selections even when the PC has not moved.
  private selectionVersion = 0;
  private listingRevision = 0;
  private assemblyMode: 'sic' | 'sicxe' = 'sic';
  private deviceIndex: number | undefined;
  private deviceVersion = -1;
  private devices?: { type: 'devices'; sessionId: string; selected?: number; devices: DeviceState[]; detail?: DeviceState; limit: number };
  private finalDevices?: DeviceResult;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private setSources(sources: Source[]): void {
    this.sources = sources;
    this.sourceAliases = new Map(sources.map(source => [uriKey(vscode.Uri.parse(source.uri)), source.uri]));
    this.sourceKeys = Promise.all(sources.map(async source => [await sourceFileKey(source.uri, vscode.Uri.parse(source.uri).fsPath), source.uri] as const))
      .then(keys => new Map(keys));
  }

  setAssembly(result: AssemblyResult, sources: Source[], folder?: vscode.WorkspaceFolder, mode?: 'sic' | 'sicxe'): void {
    this.setSources(sources);
    this.assembly = result;
    this.session = undefined;
    this.snapshot = undefined;
    this.sessionId = '';
    this.lastFolder = folder;
    this.lastMode = mode ?? getProject(folder)?.data?.mode ?? (vscode.workspace.getConfiguration('umjoonsic', folder?.uri).get('mode') === 'sicxe' ? 'sicxe' : 'sic');
    this.assemblyMode = this.lastMode;
    this.memory = undefined;
    this.devices = undefined;
    this.finalDevices = undefined;
    this.deviceVersion = -1;
    this.selectedListingRow = -1;
    this.selectedListingUri = undefined;
    this.selectionVersion++;
    this.generation++;
    this.updateListing(true);
    this.refreshState();
    this.sendSymbols();
  }

  private updateListing(rebuild = false): void {
    if (rebuild) { this.listingRows = buildListingRows(this.assembly?.rows ?? [], this.sources); this.listingRevision++; }
    if (!this.listing) return;
    void this.listing.webview.postMessage({ type: 'listing', rows: this.listingRows, sources: this.sources.map(({ uri }) => ({ uri })),
      sessionId: this.sessionId, revision: this.listingRevision, breakpoints: this.breakpoints(), selectedIndex: this.selectedListingRow,
      selectedUri: this.selectedListingUri, selectionVersion: this.selectionVersion });
    this.listingState();
    void this.updateBreakpoints();
  }

  private listingState(follow = false): void {
    void this.listing?.webview.postMessage({ type: 'state', pc: this.snapshot?.pc,
      state: this.session ? this.snapshot?.state : this.snapshot ? 'terminated' : undefined, reason: this.snapshot?.reason, follow,
      selectedUri: this.selectedListingUri, selectionVersion: this.selectionVersion });
  }

  private breakpoints(): { uri: string; line: number }[] {
    return this.sourceBreakpoints().filter(({ point }) => point.enabled).map(({ uri, line }) => ({ uri, line }));
  }

  private sourceBreakpoints(): { point: vscode.SourceBreakpoint; uri: string; line: number }[] {
    const sources = new Map(this.sourceAliases);
    this.sources.forEach((source, index) => {
      const uri = vscode.Uri.parse(source.uri);
      if (this.session) sources.set(uriKey(vscode.debug.asDebugSourceUri({ path: uri.fsPath, sourceReference: index + 1 }, this.session)), source.uri);
    });
    return vscode.debug.breakpoints.flatMap(point => {
      if (!(point instanceof vscode.SourceBreakpoint)) return [];
      const uri = sources.get(uriKey(point.location.uri));
      return uri ? [{ point, uri, line: point.location.range.start.line }] : [];
    });
  }

  private async updateBreakpoints(): Promise<void> {
    const request = ++this.breakpointRequest, sourceKeys = this.sourceKeys, session = this.session, panel = this.listing;
    const keys = await sourceKeys;
    const aliases = await Promise.all(vscode.debug.breakpoints.map(async point => {
      if (!(point instanceof vscode.SourceBreakpoint) || point.location.uri.scheme !== 'file') return;
      const key = uriKey(point.location.uri);
      if (this.sourceAliases.has(key)) return;
      const file = await sourceFileKey(point.location.uri.toString(), point.location.uri.fsPath).catch(() => undefined);
      const source = file && keys.get(file);
      return source ? [key, source] as const : undefined;
    }));
    if (sourceKeys !== this.sourceKeys) return;
    for (const alias of aliases) if (alias && !this.sourceAliases.has(alias[0])) this.sourceAliases.set(...alias);
    if (request === this.breakpointRequest && session === this.session && panel === this.listing)
      void panel?.webview.postMessage({ type: 'breakpoints', breakpoints: this.breakpoints() });
  }

  async showListing(preserveFocus = false): Promise<void> {
    if (!this.assembly) throw new Error(vscode.l10n.t("Assemble or start debugging first."));
    if (this.listing) { this.listing.reveal(this.listing.viewColumn, preserveFocus); this.updateListing(); return; }
    const panel = this.listing = vscode.window.createWebviewPanel('umjoonsic.listing', 'Listing',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
    const listeners = [
      vscode.debug.onDidChangeBreakpoints(() => { void this.updateBreakpoints(); }),
      panel.webview.onDidReceiveMessage((message: unknown) => {
        const handle = async (): Promise<void> => {
          if (!message || typeof message !== 'object') throw new Error(vscode.l10n.t("Invalid listing request."));
          const request = message as Record<string, unknown>;
          if (request.type === 'ready') { this.updateListing(); return; }
          if (request.type === 'select') {
            if (panel !== this.listing || request.sessionId !== this.sessionId || request.revision !== this.listingRevision || request.selectionVersion !== this.selectionVersion) return;
            const index = request.index, uri = request.uri;
            if (typeof index !== 'number' || !Number.isInteger(index) || typeof uri !== 'string' ||
                (index === -1 ? !this.sources.some(source => source.uri === uri) || this.listingRows.some(row => row.uri === uri)
                  : index < 0 || this.listingRows[index]?.uri !== uri)) throw new Error(vscode.l10n.t('Invalid listing row.'));
            this.sourceRequest++;
            this.selectedListingRow = index;
            this.selectedListingUri = uri;
            return;
          }
          if (request.sessionId !== this.sessionId || request.revision !== this.listingRevision) throw new Error(vscode.l10n.t('Listing changed. Try again.'));
          if (request.type === 'pc') { await this.revealPC(); return; }
          if (!['source', 'breakpoint', 'symbol', 'memory'].includes(String(request.type))) throw new Error(vscode.l10n.t("Unsupported listing request."));
          if (typeof request.index !== 'number' || !Number.isInteger(request.index)) throw new Error(vscode.l10n.t("Invalid listing row."));
          const row = this.listingRows[request.index];
          if (!row) throw new Error(vscode.l10n.t("The listing row was not found."));
          const uri = vscode.Uri.parse(row.uri);
          if (request.type === 'breakpoint') {
            if (!row.executable) return;
            const sourceKeys = this.sourceKeys, session = this.session;
            await this.updateBreakpoints();
            if (sourceKeys !== this.sourceKeys || session !== this.session || this.listing !== panel) return;
            const existing = this.sourceBreakpoints().filter(point => point.uri === row.uri && point.line === row.line).map(({ point }) => point);
            if (existing.length) {
              vscode.debug.removeBreakpoints(existing);
              if (!existing.some(point => point.enabled)) vscode.debug.addBreakpoints(existing.map(point =>
                new vscode.SourceBreakpoint(point.location, true, point.condition, point.hitCondition, point.logMessage)));
            }
            else vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(row.line, 0)))]);
          } else if (request.type === 'symbol') {
            const name = request.symbol;
            if (typeof name !== 'string' || !row.operandSymbols?.includes(name)) throw new Error(vscode.l10n.t('Invalid listing request.'));
            const target = resolveListingSymbol(row, name, this.assembly?.symbols ?? [], this.sources, this.assemblyMode);
            if (!target) throw new Error(vscode.l10n.t('Symbol {0} has no loaded definition.', name));
            const index = this.listingRows.findIndex(item => item.uri === target.uri && item.line === target.line);
            await this.revealRow(index, target.type === 'ABSOLUTE' ? undefined : target.address);
          } else if (request.type === 'memory') {
            if (row.address !== undefined) await this.revealRow(request.index, row.address);
          } else {
            await this.openSource(row, panel);
          }
        };
        void handle().catch(error => { void panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); });
      }),
    ];
    panel.onDidDispose(() => {
      if (this.listing === panel) this.listing = undefined;
      for (const listener of listeners) listener.dispose();
    });
    panel.webview.html = listingHtml(panel.webview, this.context.extensionUri);
  }

  private async revealRow(index: number, address?: number, source = false): Promise<void> {
    const assembly = this.assembly, session = this.session, row = this.listingRows[index];
    if (!row) throw new Error(vscode.l10n.t('No listing row matches this location.'));
    const request = ++this.sourceRequest;
    const selectionVersion = ++this.selectionVersion;
    const current = () => request === this.sourceRequest && selectionVersion === this.selectionVersion && this.assembly === assembly && this.session === session;
    this.selectedListingRow = index;
    this.selectedListingUri = row.uri;
    await this.showListing(true);
    if (!current()) return;
    await this.listing?.webview.postMessage({ type: 'reveal', index });
    if (!current()) return;
    if (address !== undefined && session) {
      const limit = session.configuration.mode === 'sic' ? 32768 : 1048576;
      if (address >= 0 && address < limit) {
        this.address = address & ~7;
        this.generation++;
        await this.showDebugger();
        if (!current()) return;
        void this.view?.webview.postMessage({ type: 'address', address: this.address, target: address });
      }
    }
    if (source && current()) await this.openSource(row, this.listing);
  }

  async revealSource(uri: vscode.Uri, line: number): Promise<void> {
    const sources = this.sources, session = this.session;
    const request = ++this.sourceRequest;
    const selectionVersion = this.selectionVersion;
    let source = sources.find((item, index) => uriKey(vscode.Uri.parse(item.uri)) === uriKey(uri) ||
      session && uriKey(vscode.debug.asDebugSourceUri({ path: vscode.Uri.parse(item.uri).fsPath, sourceReference: index + 1 }, session)) === uriKey(uri));
    if (!source && uri.scheme === 'file') {
      const name = (await this.sourceKeys).get(await sourceFileKey(uri.toString(), uri.fsPath));
      source = sources.find(item => item.uri === name);
    }
    if (this.sources !== sources || this.session !== session || request !== this.sourceRequest || selectionVersion !== this.selectionVersion) return;
    const index = this.listingRows.findIndex(row => row.uri === source?.uri && row.line === line);
    await this.revealRow(index, this.listingRows[index]?.address);
  }

  async revealAddress(address: number, source = false): Promise<void> {
    const limit = this.assemblyMode === 'sic' ? 32768 : 1048576;
    if (!Number.isSafeInteger(address) || address < 0 || address >= limit) throw new Error(vscode.l10n.t('Address is outside machine memory.'));
    const index = this.listingRows.findIndex(row => row.address !== undefined && row.size > 0 && address >= row.address && address < row.address + row.size);
    if (index >= 0) await this.revealRow(index, address, source);
    else if (this.session) {
      const request = ++this.sourceRequest, session = this.session;
      this.address = address & ~7; this.generation++;
      await this.showDebugger();
      if (request !== this.sourceRequest || session !== this.session) return;
      void this.view?.webview.postMessage({ type: 'address', address: this.address, target: address });
    }
  }

  async revealPC(): Promise<void> {
    if (!this.snapshot) throw new Error(vscode.l10n.t('Start debugging first.'));
    await this.revealAddress(this.snapshot.pc);
  }

  async revealVariable(context: unknown): Promise<void> {
    const value = context as { sessionId?: string; variable?: { memoryReference?: string } } | undefined;
    if (!this.session || value?.sessionId !== this.session.id || !/^0x[\da-f]+$/i.test(value.variable?.memoryReference ?? ''))
      throw new Error(vscode.l10n.t('Select a variable with memory in the current session.'));
    await this.revealAddress(Number(value.variable!.memoryReference), true);
  }

  private async openSource(row: DisplayListingRow, panel: vscode.WebviewPanel | undefined, stopped?: Snapshot): Promise<void> {
    const session = this.session, sources = this.sources;
    const uri = vscode.Uri.parse(row.uri), sourceIndex = sources.findIndex(source => source.uri === row.uri);
    const snapshot = session && sourceIndex >= 0;
    const target = snapshot ? vscode.debug.asDebugSourceUri({ path: uri.fsPath, sourceReference: sourceIndex + 1 }, session) : uri;
    const visible = () => vscode.window.visibleTextEditors.some(editor => editor.document.uri.toString() === target.toString());
    if (stopped && visible()) return;
    const request = ++this.sourceRequest;
    const current = () => request === this.sourceRequest && this.session === session && this.sources === sources &&
      (stopped ? this.snapshot === stopped : this.listing === panel);
    const options = { viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus: !!stopped,
      selection: new vscode.Range(row.line, row.column, row.line, row.column) };
    const deadline = Date.now() + 5000;
    let document: vscode.TextDocument;
    while (true) {
      if (!current()) return;
      try { document = await vscode.workspace.openTextDocument(target); break; }
      catch (error) {
        if (!current()) return;
        // VS Code registers its debug: content provider after startup restoration.
        if (!snapshot || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    if (!current()) return;
    if (stopped) {
      if (visible()) return;
      const group = vscode.window.tabGroups.all.find(group => !group.activeTab?.isDirty &&
        group.activeTab?.input instanceof vscode.TabInputText && group.activeTab.input.uri.toString() === target.toString());
      if (!group) return;
      options.viewColumn = group.viewColumn;
    }
    try { await vscode.window.showTextDocument(document, options); }
    catch (error) {
      if (!current()) return;
      if (!snapshot) throw error;
      // A failed native editor caches its rejected model promise even after the
      // document becomes available. Dispose only this clean snapshot's target tab.
      const tabs = vscode.window.tabGroups.all.filter(group => group.viewColumn === options.viewColumn)
        .flatMap(group => group.tabs).filter(tab => !tab.isDirty && tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === target.toString());
      try {
        if (!tabs.length || !await vscode.window.tabGroups.close(tabs, true)) throw error;
        if (current()) await vscode.window.showTextDocument(document, options);
      } catch (retryError) { if (current()) throw retryError; }
    }
  }

  async state(session: vscode.DebugSession, snapshot: Snapshot, initialAssembly?: PromiseLike<AssemblyResult>): Promise<void> {
    if (this.session === session && snapshot.state !== 'running' && JSON.stringify(this.snapshot) === JSON.stringify(snapshot)) {
      this.refreshState();
      return;
    }
    const sourceRequest = this.sourceRequest;
    const first = this.sessionId !== session.id;
    const follow = this.snapshot?.pc !== snapshot.pc || this.snapshot?.stepCount !== snapshot.stepCount ||
      this.snapshot?.state !== snapshot.state || this.snapshot?.reason !== snapshot.reason || snapshot.reason === 'entry';
    this.session = session;
    this.sessionId = session.id;
    this.title = session.name;
    this.lastFolder = session.workspaceFolder;
    if (follow) { this.selectedListingRow = -1; this.selectedListingUri = undefined; this.selectionVersion++; }
    this.snapshot = snapshot;
    if (first) {
      this.assembly = undefined;
      this.listingRevision++;
      this.assemblyMode = session.configuration.mode === 'sicxe' ? 'sicxe' : 'sic';
      this.setSources(session.configuration.sources ?? []);
      this.memory = undefined;
      this.devices = undefined;
      this.finalDevices = undefined;
      this.deviceVersion = -1;
      this.deviceIndex = undefined;
      this.selectedListingRow = -1;
      this.selectedListingUri = undefined;
      this.address = snapshot.pc & ~7;
      this.count = 256;
      this.generation++;
    }
    this.refreshState();
    if (snapshot.reason === 'entry') this.generation++;
    if (first) {
      const assembly = await (initialAssembly ?? session.customRequest('umjoonsic.listing'));
      if (this.session !== session) return;
      this.assembly = assembly;
      this.updateListing(true);
      this.sendSymbols();
    }
    if (first) {
      await this.showDebugger();
      if (this.session !== session) return;
      await this.showListing(true);
    }
    this.listingState(follow);
    const stopped = this.snapshot;
    // Native stack-frame navigation shares Listing's cached editor input.
    // Recover it without delaying memory updates or taking focus.
    if (stopped && stopped.state !== 'running' && this.sourceRequest === sourceRequest) {
      const row = this.listingRows.find(row => row.executable && row.address === stopped.pc);
      const panel = this.listing;
      if (row) void this.openSource(row, panel, stopped).catch(error => {
        if (panel && this.session === session && this.snapshot === stopped && this.listing === panel)
          void panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      });
    }
    if (!first) await this.refreshMemory();
  }

  terminate(session: vscode.DebugSession): void {
    if (this.session?.id !== session.id) return;
    this.session = undefined;
    this.generation++;
    this.refreshState();
    this.listingState();
    void this.updateBreakpoints();
  }

  captureDevices(session: vscode.DebugSession, result: DeviceResult): void {
    if (this.sessionId !== session.id) return;
    this.finalDevices = result;
    const detail = result.devices.find(device => device.index === this.deviceIndex) ?? result.devices[0];
    const metadata = result.devices.map(device => ({ ...device, read: '', written: '', input: undefined }));
    this.devices = { type: 'devices', sessionId: session.id, selected: detail?.index, devices: metadata, detail, limit: result.limit };
    void this.view?.webview.postMessage(this.devices);
  }

  refreshState(force = false): void {
    if (!this.view) return;
    const folder = this.session?.workspaceFolder ?? this.lastFolder ?? currentFolder();
    const project = getProject(folder);
    const settings = vscode.workspace.getConfiguration('umjoonsic', folder?.uri);
    if (this.session || !this.snapshot) {
      this.lastMode = this.session?.configuration.mode ?? project?.data?.mode ?? settings.get('mode', 'sic');
      this.lastDelay = this.session?.configuration.stepDelayMs ?? project?.data?.stepDelayMs ?? settings.get('stepDelayMs', 250);
    }
    const state = {
      type: 'state', sessionId: this.sessionId, connected: !!this.session,
      title: this.sessionId ? this.title : folder?.name ?? 'UmJoonSIC',
      mode: this.lastMode, delayMs: this.lastDelay,
      snapshot: this.snapshot,
    };
    const serialized = JSON.stringify(state);
    if (!force && serialized === this.lastState) return;
    this.lastState = serialized;
    void this.view.webview.postMessage(state);
  }

  private sendSymbols(): void {
    void this.view?.webview.postMessage({ type: 'symbols', sessionId: this.sessionId, symbols: this.assembly?.symbols ?? [] });
  }

  async showDebugger(): Promise<void> {
    await vscode.commands.executeCommand('umjoonsic.debugger.focus', { preserveFocus: true });
    this.view?.show(true);
    this.refreshState();
    await this.refreshMemory();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.lastState = "";
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    const listeners = [
      view.onDidChangeVisibility(() => {
        if (view.visible) { this.refreshState(true); this.sendSymbols(); void this.refreshMemory(); }
      }),
      view.webview.onDidReceiveMessage((message: unknown) => {
        const handle = async (): Promise<void> => {
          if (!message || typeof message !== 'object') throw new Error(vscode.l10n.t("Invalid execution request."));
          const request = message as Record<string, unknown>;
          if (['device', 'deviceOpen', 'deviceReset'].includes(String(request.type)) && request.sessionId !== this.sessionId)
            throw new Error(vscode.l10n.t('The displayed session has changed. Try again.'));
          switch (request.type) {
            case 'ready':
              this.refreshState(true);
              this.sendSymbols();
              if (this.memory) await view.webview.postMessage(this.memory);
              if (this.devices) await view.webview.postMessage(this.devices);
              await this.refreshMemory();
              return;
            case 'navigate':
              if (typeof request.address !== 'number') throw new Error(vscode.l10n.t('Invalid address.'));
              await this.revealAddress(request.address, request.source === true);
              return;
            case 'lastWrite':
              if (this.snapshot?.lastWrite) await this.revealAddress(this.snapshot.lastWrite.address);
              return;
            case 'pc': await this.revealPC(); return;
            case 'delayPreset':
              if (typeof request.value !== 'number' || !Number.isInteger(request.value) || request.value < 0 || request.value > 60000) throw new Error(vscode.l10n.t('Enter an integer from 0 to 60000.'));
              await vscode.commands.executeCommand('umjoonsic.setDelay', (this.session?.workspaceFolder ?? this.lastFolder ?? currentFolder())?.uri, this.session, request.value);
              return;
            case 'device':
              if (typeof request.index !== 'number' || !Number.isInteger(request.index) || request.index < 0 || request.index > 255) throw new Error(vscode.l10n.t('Invalid device number.'));
              this.deviceIndex = request.index;
              if (!this.session && this.finalDevices) {
                this.devices = { type: 'devices', sessionId: this.sessionId, selected: request.index,
                  devices: this.devices?.devices ?? [], detail: this.finalDevices.devices.find(device => device.index === request.index), limit: this.finalDevices.limit };
                await view.webview.postMessage(this.devices);
                return;
              }
              this.deviceVersion = -1;
              this.generation++;
              await this.refreshMemory();
              return;
            case 'deviceOpen': {
              const device = this.devices?.detail;
              if (!device || request.index !== device.index) throw new Error(vscode.l10n.t('Wait for the selected device to load.'));
              const filename = device.filename;
              if (filename) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filename));
              return;
            }
            case 'deviceReset': {
              const session = this.session, device = this.devices?.detail;
              if (request.index !== device?.index) throw new Error(vscode.l10n.t('Wait for the selected device to load.'));
              if (!session || !device?.filename || this.snapshot?.state === 'running') throw new Error(vscode.l10n.t('Pause execution and select a connected device.'));
              const file = vscode.Uri.file(device.filename), key = await sourceFileKey(file.toString(), file.fsPath);
              const shared = (await Promise.all((this.devices?.devices ?? []).map(async item => item.filename && await sourceFileKey(vscode.Uri.file(item.filename).toString(), item.filename) === key ? item.index : undefined))).filter(index => index !== undefined);
              if (session !== this.session) return;
              const clear = vscode.l10n.t('Clear file');
              if (await vscode.window.showWarningMessage(vscode.l10n.t('Clear all bytes in {0}? Devices: {1}. This cannot be undone.', device.filename, shared.join(', ')), { modal: true }, clear) !== clear) return;
              if (session !== this.session) return;
              await session.customRequest('umjoonsic.deviceReset', { index: device.index });
              this.deviceVersion = -1;
              this.generation++;
              await this.refreshMemory();
              return;
            }
            case 'read': {
              const input = typeof request.address === 'string' ? request.address.trim() : '';
              const symbols = /^0x/i.test(input) ? [] : this.assembly?.symbols ?? [];
              const qualified = input.includes('::');
              const named = (symbol: AssemblyResult['symbols'][number]) => qualified ? `${symbol.section}::${symbol.name}` : symbol.name;
              let matches = symbols.filter(symbol => named(symbol) === input);
              if (!matches.length) {
                const upper = input.toUpperCase();
                matches = symbols.filter(symbol => named(symbol).toUpperCase() === upper);
              }
              if (matches.length > 1) throw new Error(vscode.l10n.t('More than one symbol matches {0}. Use the exact SECTION::NAME.', input));
              if (matches[0]?.type === 'ABSOLUTE') throw new Error(vscode.l10n.t('Symbol {0} has no memory location.', input));
              const address = matches[0]?.address ?? (/^(?:0x)?[0-9a-f]+$/i.test(input) ? parseInt(input.replace(/^0x/i, ''), 16) : NaN);
              const count = request.count;
              if (!Number.isInteger(address) || address < 0 || typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 4096) throw new Error(vscode.l10n.t('Enter a hexadecimal address or symbol and a size from 1 to 4096 bytes.'));
              const limit = this.session?.configuration.mode === 'sic' ? 32768 : 1048576;
              if (!this.session) throw new Error(vscode.l10n.t("Start execution to read memory."));
              if (address >= limit) throw new Error(vscode.l10n.t("Address is outside machine memory."));
              if (this.address !== address || this.count !== count) this.generation++;
              this.address = address;
              this.count = count;
              await this.refreshMemory();
              return;
            }
            case 'copy':
              if (typeof request.text !== 'string' || request.text.length > 65536) throw new Error(vscode.l10n.t("Invalid data to copy."));
              await vscode.env.clipboard.writeText(request.text);
              return;
            case 'control': await this.control(request.action); return;
            default: throw new Error(vscode.l10n.t("Unsupported execution request."));
          }
        };
        void handle().catch(error => {
          void view.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        });
      }),
    ];
    view.onDidDispose(() => {
      if (this.view === view) { this.view = undefined; this.generation++; }
      for (const listener of listeners) listener.dispose();
    });
    view.webview.html = debugViewHtml(view.webview, this.context.extensionUri);
  }

  private async control(action: unknown): Promise<void> {
    const session = this.session;
    const folder = session?.workspaceFolder ?? this.lastFolder ?? currentFolder();
    if (action === 'settings') {
      await refreshProjects();
      const project = getProject(folder);
      if (!project?.uri) throw new Error(vscode.l10n.t("Right-click the practice folder in Explorer to create a SIC project."));
      await vscode.commands.executeCommand('vscode.openWith', project.uri, 'umjoonsic.project');
    } else if (action === 'delay') {
      await vscode.commands.executeCommand('umjoonsic.setDelay', folder?.uri, session);
      this.refreshState(true);
    } else if (action === 'debug' || action === 'run' || action === 'assemble') {
      if (session) throw new Error(vscode.l10n.t("Stop the current session first."));
      await vscode.commands.executeCommand(`umjoonsic.${action}`, folder?.uri);
    } else if (['continue', 'pause', 'stepIn', 'next', 'stepOut', 'restart', 'stop'].includes(String(action))) {
      if (!session) throw new Error(vscode.l10n.t("Start SIC debugging first."));
      if (action === 'stop') await vscode.debug.stopDebugging(session);
      else {
        if (['continue', 'stepIn', 'next', 'stepOut'].includes(String(action)) && this.snapshot?.state !== 'paused') throw new Error(vscode.l10n.t("This action requires a paused session."));
        if (action === 'pause' && this.snapshot?.state !== 'running') return;
        await session.customRequest(String(action), { threadId: 1 });
      }
    } else throw new Error(vscode.l10n.t("Unsupported execution control."));
    this.refreshState();
  }

  async refreshMemory(): Promise<void> {
    if (!this.view?.visible || !this.session) return;
    this.memoryAgain = true;
    if (this.memoryUpdate) return this.memoryUpdate;
    const update = async (): Promise<void> => {
      while (this.memoryAgain && this.view?.visible && this.session) {
        this.memoryAgain = false;
        const view = this.view, session = this.session, generation = this.generation;
        try {
          const limit = session.configuration.mode === 'sic' ? 32768 : 1048576;
          if (this.address >= limit) this.address = 0;
          const count = this.count;
          const result = await session.customRequest('umjoonsic.memory', { address: this.address, count: Math.min(count, limit - this.address) });
          if (generation !== this.generation || view !== this.view || session !== this.session) continue;
          this.memory = { type: 'memory', ...result, sessionId: session.id, count, pc: this.snapshot?.pc };
          await view.webview.postMessage(this.memory);
          const version = this.snapshot?.deviceVersion ?? 0;
          if (this.deviceVersion !== version) {
            const metadata = await session.customRequest('umjoonsic.devices', { count: 0 }) as DeviceResult;
            const index = metadata.devices.some(device => device.index === this.deviceIndex) ? this.deviceIndex : metadata.devices[0]?.index;
            const detail = index === undefined ? undefined : (await session.customRequest('umjoonsic.devices', { index, count: 8192 }) as DeviceResult).devices[0];
            if (generation !== this.generation || view !== this.view || session !== this.session) continue;
            this.deviceIndex = index;
            this.deviceVersion = version;
            this.devices = { type: 'devices', sessionId: session.id, selected: index, devices: metadata.devices, detail, limit: metadata.limit };
            await view.webview.postMessage(this.devices);
          }
        } catch (error) {
          if (generation === this.generation && view === this.view && session === this.session) {
            await view.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    };
    this.memoryUpdate = update();
    try { await this.memoryUpdate; }
    finally { this.memoryUpdate = undefined; }
  }

  dispose(): void { this.generation++; this.session = undefined; this.listing?.dispose(); }
}

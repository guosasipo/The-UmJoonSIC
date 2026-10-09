import { basename } from 'node:path';
import { DebugSession, InitializedEvent, StoppedEvent, ContinuedEvent, TerminatedEvent, OutputEvent, Event, Source } from '@vscode/debugadapter';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { EngineClient } from './engineClient';
import { getExportedSymbols, reference } from './language';
import { sourceFileKey } from './sourceFiles';
import type { AssemblyResult, DeviceResult, LaunchArguments, ListingRow, LoadResult, ProgramSymbol, Snapshot } from './protocol';

const hex = (value: number) => `0x${value.toString(16).toUpperCase().padStart(6, '0')}`;
const signed24 = (value: number) => (value & 0xFFFFFF) >= 0x800000 ? (value & 0xFFFFFF) - 0x1000000 : value & 0xFFFFFF;
const uriKey = (value: string) => {
  const uri = new URL(value);
  const path = decodeURIComponent(uri.pathname);
  return `${uri.protocol}//${uri.host}${process.platform === 'win32' ? path.toLowerCase() : path}${uri.search}${uri.hash}`;
};
type Disassembled = { address: number; bytes: string; instruction: string; invalid?: boolean };

export class UmJoonDebugSession extends DebugSession {
  private client?: EngineClient;
  private arguments?: LaunchArguments;
  private assembly?: AssemblyResult;
  private sourceRows = new Map<string, Map<number, ListingRow>>();
  private sourceFiles = new Map<string, string>();
  private sourceUris = new Map<string, Promise<string | undefined>>();
  private instructionRows = new Map<number, ListingRow>();
  private instructionAddresses: number[] = [];
  private snapshot?: Snapshot;
  private breakpoints = new Map<string, number[]>();
  private configured!: () => void;
  private configuration = new Promise<void>(resolve => { this.configured = resolve; });
  private deferredStops?: Snapshot[];
  private deferredProgress?: Snapshot;
  private notificationVersion = 0;
  private activeControl?: Promise<void>;
  private closed = false;
  private stopping?: DebugProtocol.Response[];
  private lastState = '';

  constructor(private readonly options: { createClient: () => Promise<EngineClient>; onDispose?: () => void }) {
    super();
    this.setDebuggerPathFormat('uri');
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);
  }

  private answer(response: DebugProtocol.Response, action: () => Promise<object | void>, after?: () => void): void {
    void Promise.resolve().then(action).then(body => {
      if (body) response.body = body;
      this.sendResponse(response);
      after?.();
    }, error => {
      const message = error instanceof Error ? error.message : String(error);
      this.sendErrorResponse(response, 1, '{message}', { message });
      if (response.command === 'launch' && !this.closed) {
        this.sendEvent(new TerminatedEvent());
        this.dispose();
      }
    });
  }

  private engine(): EngineClient {
    if (!this.client || this.closed) throw new Error('실행 중인 엔진이 없습니다.');
    return this.client;
  }

  protected initializeRequest(response: DebugProtocol.InitializeResponse): void {
    response.body = {
      supportsConfigurationDoneRequest: true, supportsRestartRequest: true,
      supportsTerminateRequest: true, supportsReadMemoryRequest: true,
      supportsDisassembleRequest: true, supportsEvaluateForHovers: true,
      supportsSteppingGranularity: true, exceptionBreakpointFilters: [],
    };
    this.sendResponse(response);
  }

  protected launchRequest(response: DebugProtocol.LaunchResponse, args: DebugProtocol.LaunchRequestArguments & LaunchArguments): void {
    this.answer(response, async () => {
      this.arguments = args;
      this.client = await this.options.createClient();
      if (this.closed) { this.client.dispose(); throw new Error('실행이 취소되었습니다.'); }
      this.client.on('log', text => this.sendEvent(new OutputEvent(String(text), 'stderr')));
      this.client.on('stopped', (snapshot: Snapshot) => {
        this.notificationVersion++;
        if (this.deferredStops) this.deferredStops.push(snapshot);
        else this.accept(snapshot);
      });
      this.client.on('progress', (snapshot: Snapshot) => {
        this.notificationVersion++;
        if (this.deferredStops) this.deferredProgress = snapshot;
        else this.progress(snapshot);
      });
      this.client.on('exit', error => {
        if (this.closed) return;
        this.sendEvent(new OutputEvent(`${error.message}\n`, 'stderr'));
        this.dispose();
        this.sendEvent(new TerminatedEvent());
      });
      const files = await Promise.all(args.sources.map(async source => [await sourceFileKey(source.uri), source.uri] as const));
      if (this.closed || this.stopping) throw new Error('실행이 취소되었습니다.');
      this.sourceFiles = new Map(files);
      for (const source of args.sources) this.sourceUris.set(uriKey(source.uri), Promise.resolve(source.uri));
      await this.load();
      this.sendEvent(new InitializedEvent());
      await this.configuration;
      if (this.closed || this.stopping) throw new Error('실행이 취소되었습니다.');
    }, () => {
      if (args.stopOnEntry !== false) this.accept({ ...this.snapshot!, reason: 'entry' });
      else this.transition(undefined, 'continue', { delayMs: args.stepDelayMs ?? 0 });
    });
  }

  private async load(): Promise<void> {
    const result = await this.engine().request<LoadResult>('load', this.arguments!);
    if (!result.assembly.success) {
      const message = result.assembly.diagnostics.map(d => `${d.uri}: ${d.message}`).join('\n');
      this.sendEvent(new OutputEvent(`${message}\n`, 'stderr'));
      throw new Error(message || '어셈블 실패');
    }
    this.assembly = result.assembly;
    this.sourceRows.clear();
    this.instructionRows.clear();
    const sourceKeys = new Map<string, string>();
    for (const row of result.assembly.rows) {
      if (!row.executable) continue;
      let key = sourceKeys.get(row.uri);
      if (key === undefined) { key = uriKey(row.uri); sourceKeys.set(row.uri, key); }
      let lines = this.sourceRows.get(key);
      if (!lines) this.sourceRows.set(key, lines = new Map());
      if (!lines.has(row.line)) lines.set(row.line, row);
      if (!this.instructionRows.has(row.address)) this.instructionRows.set(row.address, row);
    }
    this.instructionAddresses = [...this.instructionRows.keys()].sort((a, b) => a - b);
    this.snapshot = result.snapshot;
    this.lastState = '';
  }

  protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): void {
    this.sendResponse(response);
    this.configured();
  }

  private sourceUri(uri: string): Promise<string | undefined> {
    const key = uriKey(uri);
    let source = this.sourceUris.get(key);
    if (!source) {
      source = sourceFileKey(uri).then(file => {
        const resolved = this.sourceFiles.get(file);
        if (!resolved && this.sourceUris.get(key) === source) this.sourceUris.delete(key);
        return resolved;
      }, error => {
        if (this.sourceUris.get(key) === source) this.sourceUris.delete(key);
        throw error;
      });
      this.sourceUris.set(key, source);
    }
    return source;
  }

  protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
    this.answer(response, async () => {
      const sourceReference = args.source.sourceReference === undefined ? 0 : args.source.sourceReference;
      if (!Number.isSafeInteger(sourceReference) || sourceReference < 0) throw new Error('소스 참조가 올바르지 않습니다.');
      const uri = sourceReference
        ? this.arguments?.sources[sourceReference - 1]?.uri
        : args.source.path && this.convertClientPathToDebugger(args.source.path);
      if (!uri || !this.assembly) throw new Error('어셈블된 소스가 아닙니다.');
      const key = uriKey(uri), source = await this.sourceUri(uri);
      const lines = source ? this.sourceRows.get(uriKey(source)) : undefined;
      const engine = this.engine();
      const addresses: number[] = [];
      const breakpoints = (args.breakpoints ?? []).map(bp => {
        const row = lines?.get(this.convertClientLineToDebugger(bp.line));
        const supported = !bp.condition && !bp.hitCondition && !bp.logMessage;
        if (row && supported) addresses.push(row.address);
        return {
          verified: !!row && supported, line: bp.line, source: args.source,
          instructionReference: row && supported ? hex(row.address) : undefined,
          message: !supported ? '조건부 중단점과 로그포인트는 지원하지 않습니다.'
            : !row ? '이 행에는 실행 가능한 명령이 없습니다.' : undefined,
        };
      });
      // The client replaces file and snapshot breakpoint collections independently.
      this.breakpoints.set(sourceReference ? `sourceReference:${sourceReference}` : `path:${key}`, addresses);
      await engine.request('breakpoints', { addresses: [...new Set([...this.breakpoints.values()].flat())] });
      return { breakpoints };
    });
  }

  private accept(snapshot: Snapshot): void {
    if (this.closed) return;
    const wasRunning = this.snapshot?.state === 'running';
    this.snapshot = snapshot;
    const state = JSON.stringify(snapshot);
    if (state === this.lastState) return;
    this.lastState = state;
    this.sendEvent(new Event('umjoonsic.state', snapshot));
    if (this.stopping) return;
    if (snapshot.state === 'running') {
      if (!wasRunning) this.sendEvent(new ContinuedEvent(1, true));
    }
    else {
      const reason = snapshot.state === 'failed' ? 'exception'
        : ['entry', 'breakpoint', 'step'].includes(snapshot.reason ?? '') ? snapshot.reason! : 'pause';
      this.sendEvent(new StoppedEvent(reason, 1, snapshot.message));
      if (snapshot.state === 'halted' || snapshot.state === 'failed') {
        this.sendEvent(new OutputEvent(`${snapshot.state}: ${snapshot.message ?? snapshot.reason ?? ''}\n`));
      }
    }
  }

  private progress(snapshot: Snapshot): void {
    if (this.closed || snapshot.state !== 'running') return;
    this.snapshot = snapshot;
    this.lastState = JSON.stringify(snapshot);
    this.sendEvent(new Event('umjoonsic.state', snapshot));
  }

  private transition(response: DebugProtocol.Response | undefined, command: string, args: object = {}): void {
    if (this.stopping) {
      if (response) this.sendErrorResponse(response, 1, 'The debug session is stopping.');
      return;
    }
    if (this.activeControl) {
      void this.activeControl.then(() => this.transition(response, command, args));
      return;
    }
    this.deferredStops = [];
    this.activeControl = Promise.resolve().then(async () => {
      if (command !== 'restart') return this.engine().request<Snapshot>(command, args);
      await this.load();
      if (this.closed || this.stopping) throw new Error('실행이 취소되었습니다.');
      // Notifications received before load completed describe the previous machine.
      this.deferredStops = [];
      this.deferredProgress = undefined;
      await this.engine().request('breakpoints', { addresses: [...new Set([...this.breakpoints.values()].flat())] });
      return this.arguments?.stopOnEntry === false
        ? this.engine().request<Snapshot>('continue') : { ...this.snapshot!, reason: 'entry' };
    }).then(snapshot => {
      const stopped = this.deferredStops!.at(-1);
      const progress = this.deferredProgress;
      this.deferredStops = undefined;
      this.deferredProgress = undefined;
      if (response) {
        if (command === 'continue') response.body = { allThreadsContinued: true };
        this.sendResponse(response);
      }
      // The engine also notifies stops. Publishing the response's paused state
      // lets its delayed notification overwrite the next command's newer state.
      // Restart's load has no stop notification, so it publishes its entry here.
      if (snapshot.state === 'running' || command === 'restart') this.accept(snapshot);
      if (progress) this.progress(progress);
      if (stopped) this.accept(stopped);
    }, error => {
      const stopped = this.deferredStops?.at(-1);
      const progress = this.deferredProgress;
      this.deferredStops = undefined;
      this.deferredProgress = undefined;
      if (response) this.sendErrorResponse(response, 1, '{message}', { message: String(error.message ?? error) });
      else this.sendEvent(new OutputEvent(`${error.message ?? error}\n`, 'stderr'));
      if (progress) this.progress(progress);
      if (stopped) this.accept(stopped);
    }).finally(() => { this.activeControl = undefined; });
  }

  protected continueRequest(response: DebugProtocol.ContinueResponse): void { this.transition(response, 'continue'); }
  protected nextRequest(response: DebugProtocol.NextResponse): void { this.transition(response, 'step', { kind: 'over' }); }
  protected stepInRequest(response: DebugProtocol.StepInResponse): void { this.transition(response, 'step', { kind: 'in' }); }
  protected stepOutRequest(response: DebugProtocol.StepOutResponse): void { this.transition(response, 'step', { kind: 'out' }); }
  protected pauseRequest(response: DebugProtocol.PauseResponse): void { this.transition(response, 'pause'); }

  protected restartRequest(response: DebugProtocol.RestartResponse): void { this.transition(response, 'restart'); }

  override dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.breakpoints.clear();
    this.sourceFiles.clear();
    this.sourceUris.clear();
    this.configured();
    try {
      this.client?.dispose();
      super.dispose();
    } finally { this.options.onDispose?.(); }
  }

  protected disconnectRequest(response: DebugProtocol.DisconnectResponse): void {
    if (this.closed) { this.sendResponse(response); return; }
    if (this.stopping) { this.stopping.push(response); return; }
    this.stopping = [response];
    const client = this.client;
    let timer: NodeJS.Timeout | undefined;
    const capture = client && this.assembly ? (async () => {
      const snapshot = await client.request<Snapshot>('pause');
      if (this.closed) return;
      this.accept(snapshot);
      const result = await client.request<DeviceResult>('devices', { count: 8192, preview: false });
      if (!this.closed) this.sendEvent(new Event('umjoonsic.devices', result));
    })().catch(() => {}) : Promise.resolve();
    void Promise.race([capture, new Promise<void>(resolve => { timer = setTimeout(resolve, 750); })]).finally(() => {
      clearTimeout(timer);
      const responses = this.stopping ?? [];
      this.stopping = undefined;
      for (const pending of responses) this.sendResponse(pending);
      if (!this.closed) {
        this.sendEvent(new TerminatedEvent());
        this.dispose();
      }
    });
  }
  protected terminateRequest(response: DebugProtocol.TerminateResponse): void { this.disconnectRequest(response); }
  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = { threads: [{ id: 1, name: 'SIC CPU' }] };
    this.sendResponse(response);
  }

  private source(row: ListingRow): Source {
    const path = this.convertDebuggerPathToClient(row.uri);
    return new Source(basename(path), path, (this.arguments?.sources.findIndex(s => s.uri === row.uri) ?? -1) + 1);
  }

  protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
    this.answer(response, async () => {
      const pc = this.snapshot?.pc;
      if (pc === undefined) throw new Error('CPU 상태가 없습니다.');
      const row = this.instructionRows.get(pc);
      return { totalFrames: 1, stackFrames: (args.startFrame ?? 0) > 0 ? [] : [{
        id: 1, name: row?.label || row?.instruction || `PC ${hex(pc)}`,
        source: row && this.source(row), instructionPointerReference: hex(pc),
        line: row ? this.convertDebuggerLineToClient(row.line) : 0,
        column: row ? this.convertDebuggerColumnToClient(row.column) : 0,
      }] };
    });
  }

  protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments): void {
    this.answer(response, async () => {
      const source = this.arguments?.sources[args.sourceReference - 1];
      if (!source) throw new Error('소스 스냅샷이 없습니다.');
      return { content: source.text, mimeType: 'text/x-umjoonsic' };
    });
  }

  protected scopesRequest(response: DebugProtocol.ScopesResponse): void {
    response.body = { scopes: [
      { name: 'Registers', variablesReference: 1, namedVariables: this.registerVariables().length, expensive: false },
      { name: 'Symbols', variablesReference: 2, namedVariables: this.assembly?.symbols.length ?? 0, expensive: true },
    ] };
    this.sendResponse(response);
  }

  private registerVariables(): DebugProtocol.Variable[] {
    if (!this.snapshot) return [];
    const names = this.arguments?.mode === 'sic' ? ['A', 'X', 'L', 'SW', 'PC'] : ['A', 'X', 'L', 'B', 'S', 'T', 'SW', 'PC', 'F'];
    return names.map(name => {
      const value = this.snapshot!.registers[name as keyof Snapshot['registers']];
      return { name, value: name === 'F' ? `${value} (0x${this.snapshot!.registers.FHex})`
        : `${signed24(Number(value))} (${hex(Number(value) & 0xFFFFFF)})`,
      variablesReference: 0, evaluateName: `$${name}`, memoryReference: name === 'PC' ? hex(Number(value)) : undefined };
    });
  }

  private format(bytes: string, type: string): string {
    const buffer = Buffer.from(bytes, 'hex');
    if (buffer.length === 6 && type === 'FLOAT') {
      return `${Buffer.concat([buffer, Buffer.alloc(2)]).readDoubleBE()} (0x${bytes.toUpperCase()})`;
    }
    const value = buffer.length ? buffer.readUIntBE(0, buffer.length) : 0;
    const chars = [...buffer].map(byte => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.').join('');
    return `${buffer.length === 3 ? signed24(value) : value} (0x${bytes.toUpperCase()}; '${chars}')`;
  }

  private async readBytes(address: number, count: number): Promise<string> {
    const engine = this.engine();
    const limit = this.arguments?.mode === 'sic' ? 32768 : 1048576;
    if (!Number.isSafeInteger(address) || address < 0 || !Number.isSafeInteger(count) || count < 0 || address + count > limit) throw new Error('메모리 조회 범위가 올바르지 않습니다.');
    const chunks: string[] = [];
    for (let offset = 0; offset < count; offset += 65536) {
      const memory = await engine.request<{ bytes: string }>('memory', { address: address + offset, count: Math.min(65536, count - offset) });
      chunks.push(memory.bytes);
    }
    return chunks.join('');
  }

  private async symbolVariable(symbol: ProgramSymbol, index: number, bytes?: string): Promise<DebugProtocol.Variable> {
    const constant = symbol.type === 'ABSOLUTE';
    let value = constant ? `${symbol.address} (${hex(symbol.address & 0xFFFFFF)})` : hex(symbol.address);
    if (symbol.count === 1 && symbol.elementSize > 0) {
      value = this.format(bytes ?? await this.readBytes(symbol.address, symbol.elementSize), symbol.type);
    }
    return { name: `${symbol.section}::${symbol.name}${symbol.count > 1 ? '[]' : ''}`, value, type: symbol.type,
      evaluateName: `${symbol.section}::${symbol.name}`, memoryReference: constant ? undefined : hex(symbol.address),
      variablesReference: symbol.count > 1 ? 100 + index : 0,
      indexedVariables: symbol.count > 1 ? symbol.count : undefined };
  }

  private async symbolVariables(start: number, count: number): Promise<DebugProtocol.Variable[]> {
    const selected = (this.assembly?.symbols ?? []).slice(start, count ? start + count : undefined)
      .map((symbol, offset) => ({ symbol, index: start + offset }));
    const groups: { address: number; end: number; items: typeof selected }[] = [];
    for (const item of selected.filter(({ symbol }) => symbol.count === 1 && symbol.elementSize > 0).sort((a, b) => a.symbol.address - b.symbol.address)) {
      const end = item.symbol.address + item.symbol.elementSize;
      const group = groups.at(-1);
      if (group && item.symbol.address <= group.end && end - group.address <= 65536) {
        group.end = Math.max(group.end, end);
        group.items.push(item);
      } else groups.push({ address: item.symbol.address, end, items: [item] });
    }
    const values = new Map<number, string>();
    for (const group of groups) {
      const bytes = await this.readBytes(group.address, group.end - group.address);
      for (const { symbol, index } of group.items) {
        const offset = (symbol.address - group.address) * 2;
        values.set(index, bytes.slice(offset, offset + symbol.elementSize * 2));
      }
    }
    return Promise.all(selected.map(({ symbol, index }) => this.symbolVariable(symbol, index, values.get(index))));
  }

  protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
    this.answer(response, async () => {
      const start = args.start ?? 0;
      const count = args.count ?? 0;
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 0) throw new Error('잘못된 배열 범위');
      if (args.filter !== undefined && args.filter !== 'named' && args.filter !== 'indexed') throw new Error('잘못된 변수 필터');
      if (args.variablesReference === 1) return { variables: args.filter === 'indexed' ? [] : this.registerVariables().slice(start, count ? start + count : undefined) };
      if (this.snapshot?.state === 'running') throw new Error('일시 정지 후 값을 확인해 주세요.');
      const symbols = this.assembly?.symbols ?? [];
      if (args.variablesReference === 2) {
        return { variables: args.filter === 'indexed' ? [] : await this.symbolVariables(start, count) };
      }
      const symbol = symbols[args.variablesReference - 100];
      if (!symbol || symbol.count <= 1 || symbol.elementSize < 1) throw new Error('알 수 없는 변수 참조');
      if (args.filter === 'named') return { variables: [] };
      const length = Math.max(0, Math.min(count || symbol.count, symbol.count - start));
      if (!length) return { variables: [] };
      const bytes = await this.readBytes(symbol.address + start * symbol.elementSize, length * symbol.elementSize);
      return { variables: Array.from({ length }, (_, index) => ({
        name: `[${start + index}]`, value: this.format(bytes.slice(index * symbol.elementSize * 2, (index + 1) * symbol.elementSize * 2), symbol.type),
        variablesReference: 0, memoryReference: hex(symbol.address + (start + index) * symbol.elementSize),
      })) };
    });
  }

  protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
    this.answer(response, async () => {
      const expression = args.expression.trim();
      let registerName = expression.replace(/^\$/, '').toUpperCase();
      let definitions: { uri: string; line: number; name: string }[] | undefined;
      if (args.context === 'hover' && (args.source !== undefined || args.line !== undefined || args.column !== undefined)) {
        if (args.source?.sourceReference !== undefined && (!Number.isSafeInteger(args.source.sourceReference) || args.source.sourceReference < 0))
          throw new Error('소스 위치가 올바르지 않습니다.');
        const uri = args.source?.path && this.convertClientPathToDebugger(args.source.path);
        const sourceUri = !args.source?.sourceReference && uri ? await this.sourceUri(uri) : undefined;
        const source = args.source?.sourceReference
          ? this.arguments?.sources[args.source.sourceReference - 1]
          : this.arguments?.sources.find(item => item.uri === sourceUri);
        if (!source || !Number.isSafeInteger(args.line) || !Number.isSafeInteger(args.column)) throw new Error('소스 위치가 올바르지 않습니다.');
        const line = this.convertClientLineToDebugger(args.line!), character = this.convertClientColumnToDebugger(args.column!);
        const target = line >= 0 && character >= 0 && reference(source.text, line, character, this.arguments!.mode);
        if (!target || character >= target.word.end || target.word.value !== expression || target.block || (!target.symbol && !target.register))
          throw new Error('이 위치에는 조회할 심볼이나 레지스터가 없습니다.');
        registerName = target.register ?? '';
        definitions = target.external
          ? this.arguments!.sources.flatMap(item => getExportedSymbols(item.text, this.arguments!.mode)
            .filter(symbol => symbol.name === expression).map(symbol => ({ ...symbol, uri: item.uri })))
          : target.symbol ? [{ ...target.symbol, uri: source.uri }] : [];
      }
      const register = this.registerVariables().find(variable => variable.name === registerName);
      if (register) return { result: register.value, variablesReference: 0, memoryReference: register.memoryReference };
      if (this.snapshot?.state === 'running') throw new Error('일시 정지 후 값을 확인해 주세요.');
      const row = this.snapshot && this.instructionRows.get(this.snapshot.pc);
      const matches = this.assembly?.symbols.map((symbol, index) => ({ symbol, index }))
        .filter(({ symbol }) => definitions
          ? definitions.some(definition => definition.uri === symbol.uri && definition.line === symbol.line && definition.name === symbol.name)
          : expression === `${symbol.section}::${symbol.name}` || expression === symbol.name) ?? [];
      const local = definitions ? matches : matches.filter(({ symbol }) => symbol.section === row?.section && symbol.uri === row.uri);
      const match = local.length === 1 ? local[0] : matches.length === 1 ? matches[0] : undefined;
      if (match) {
        const variable = await this.symbolVariable(match.symbol, match.index);
        return { ...variable, result: variable.value };
      }
      if (definitions) throw new Error(matches.length > 1 ? '심볼의 정의를 하나로 결정할 수 없습니다.' : '실행 소스에서 심볼을 찾을 수 없습니다.');
      const memory = /^(?:mem\[)?(0x[\da-f]+|\d+)(?:\s*,\s*(\d+))?\]?$/i.exec(expression);
      if (!memory || (expression.startsWith('mem[') !== expression.endsWith(']'))) {
        throw new Error(matches.length > 1 ? '심볼이 중복됩니다. SECTION::NAME으로 지정해 주세요.' : '레지스터, 심볼 또는 mem[주소,바이트수]를 입력해 주세요.');
      }
      const address = Number(memory[1]), count = Number(memory[2] ?? 3);
      if (!Number.isSafeInteger(address) || !Number.isSafeInteger(count) || count < 1 || count > 256) throw new Error('메모리 조회는 1~256바이트입니다.');
      const result = await this.engine().request<{ bytes: string }>('memory', { address, count });
      return { result: count <= 3 ? this.format(result.bytes, 'BYTE') : result.bytes.toUpperCase().match(/../g)?.join(' ') ?? '',
        variablesReference: 0, memoryReference: hex(address) };
    });
  }

  protected readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments): void {
    this.answer(response, async () => {
      const offset = args.offset ?? 0, count = args.count;
      const address = this.address(args.memoryReference) + offset;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || count < 0 ||
          !Number.isSafeInteger(address) || !Number.isSafeInteger(address + count)) throw new Error('메모리 조회 범위가 올바르지 않습니다.');
      this.engine();
      // A read stops at the first unreadable span. Report its length so the client
      // can skip it without shifting readable bytes to a different address.
      if (address < 0) return { address: String(address), data: '', unreadableBytes: Math.min(count, -address) };
      const limit = this.arguments?.mode === 'sic' ? 32768 : 1048576;
      const readable = Math.max(0, Math.min(count, limit - address));
      const bytes = readable ? await this.readBytes(address, readable) : '';
      return { address: hex(address), data: Buffer.from(bytes, 'hex').toString('base64'), unreadableBytes: count - readable };
    });
  }

  private address(value: string): number {
    if (!/^(?:0x[\da-f]+|\d+)$/i.test(value)) throw new Error('잘못된 메모리 주소');
    const address = Number(value);
    if (!Number.isSafeInteger(address) || address < 0) throw new Error('잘못된 메모리 주소');
    return address;
  }

  private async readInstructions(address: number, count: number, end: number): Promise<Disassembled[]> {
    const instructions: Disassembled[] = [];
    while (instructions.length < count && address >= 0 && address < end) {
      const start = address;
      const result = await this.engine().request<{ instructions: Disassembled[] }>('disassemble', {
        address, count: Math.min(128, count - instructions.length, end - address),
      });
      if (!result.instructions.length) break;
      for (const instruction of result.instructions) {
        if (instruction.address >= end) break;
        const next = instruction.address + instruction.bytes.length / 2;
        if (next <= address) throw new Error('역어셈블 응답의 명령 크기가 올바르지 않습니다.');
        instructions.push(next <= end ? instruction : { ...instruction, bytes: '', instruction: '<invalid>', invalid: true });
        address = next;
      }
      if (address <= start) throw new Error('역어셈블 응답이 요청 주소에서 진행하지 않습니다.');
    }
    return instructions;
  }

  protected disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments): void {
    this.answer(response, async () => {
      const limit = this.arguments?.mode === 'sic' ? 32768 : 1048576;
      const byteOffset = args.offset ?? 0, offset = args.instructionOffset ?? 0, count = args.instructionCount;
      let address = this.address(args.memoryReference) + byteOffset;
      if (!Number.isSafeInteger(byteOffset) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || count < 0 || count > limit ||
          !Number.isSafeInteger(address) || !Number.isSafeInteger(address + offset + count)) throw new Error('역어셈블 조회 범위가 올바르지 않습니다.');
      let instructions: Disassembled[] = [];
      const fill = (start: number, length: number) => {
        for (let i = 0; i < length; i++) instructions.push({ address: start + i, bytes: '', instruction: '<invalid>', invalid: true });
      };
      if (offset < 0 && count) {
        // Variable-length instructions cannot be decoded backwards reliably. Use a nearby
        // assembled boundary, then decode forwards; unknown preceding boundaries are filler.
        const anchor = this.instructionAddresses.find(value => value >= Math.max(0, address + offset * 4) && value < address);
        const before = anchor !== undefined && address <= limit
          ? (await this.readInstructions(anchor, address - anchor, address)).slice(offset) : [];
        const missing = -offset - before.length;
        fill((before[0]?.address ?? address) - missing, Math.min(count, missing));
        instructions = instructions.concat(before.slice(0, count - instructions.length));
      }
      let skip = Math.max(0, offset);
      if (address < 0) {
        const skipped = Math.min(skip, -address);
        address += skipped; skip -= skipped;
        const unavailable = Math.min(count - instructions.length, -address);
        fill(address, unavailable); address += unavailable;
      }
      if (instructions.length < count) {
        const available = await this.readInstructions(address, skip + count - instructions.length, limit);
        instructions = instructions.concat(available.slice(skip));
        const last = available.at(-1);
        const next = (last ? last.address + last.bytes.length / 2 : address) + Math.max(0, skip - available.length);
        fill(next, count - instructions.length);
      }
      return { instructions: instructions.map(instruction => {
        const row = !instruction.invalid && this.instructionRows.get(instruction.address);
        return { address: instruction.invalid ? '-1' : hex(instruction.address),
          instructionBytes: instruction.bytes, instruction: instruction.instruction,
          presentationHint: instruction.invalid ? 'invalid' : undefined,
          location: row ? this.source(row) : undefined, line: row ? this.convertDebuggerLineToClient(row.line) : undefined,
          column: row ? this.convertDebuggerColumnToClient(row.column) : undefined };
      }) };
    });
  }

  protected customRequest(command: string, response: DebugProtocol.Response, args: any): void {
    this.answer(response, async () => {
      if (command === 'umjoonsic.listing') return this.assembly ?? {};
      if (command === 'umjoonsic.snapshot') return this.snapshot ?? {};
      if (command === 'umjoonsic.memory') return this.engine().request('memory', args);
      if (command === 'umjoonsic.devices') return this.engine().request('devices', args);
      if (command === 'umjoonsic.setDelay' || command === 'umjoonsic.deviceReset') {
        if (this.stopping) throw new Error('The debug session is stopping.');
        const version = this.notificationVersion;
        const delay = command === 'umjoonsic.setDelay';
        const snapshot = await this.engine().request<Snapshot>(delay ? 'setDelay' : 'deviceReset', delay ? { delayMs: args?.delayMs } : { index: args?.index });
        if (delay && this.arguments) this.arguments.stepDelayMs = args.delayMs;
        if (version === this.notificationVersion) {
          this.snapshot = snapshot;
          this.sendEvent(new Event('umjoonsic.state', snapshot));
        }
        return this.snapshot;
      }
      throw new Error(`지원하지 않는 요청: ${command}`);
    });
  }
}

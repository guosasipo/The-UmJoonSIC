import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

export interface EngineOptions {
  javaPath: string;
  jarPath: string;
}

/** One isolated JVM; stdout is reserved for protocol 1. */
export class EngineClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private closed?: Error;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(private readonly options: EngineOptions) { super(); }

  ready(): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    return this.starting ??= this.start();
  }

  private async start(): Promise<void> {
    const child = this.child = spawn(this.options.javaPath, ['-jar', this.options.jarPath], {
      stdio: 'pipe', windowsHide: true,
    });
    child.stderr.setEncoding('utf8').on('data', text => this.emit('log', String(text)));
    child.on('error', error => this.fail(new Error(`Java 실행 실패: ${error.message}`)));
    child.on('exit', (code, signal) => this.fail(new Error(`Java 엔진 종료 (${signal ?? code})`)));
    child.stdin.on('error', error => this.fail(error));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      try {
        const message = JSON.parse(line);
        if (['stopped', 'progress'].includes(message.event) && message.body && typeof message.body.pc === 'number') {
          this.emit(message.event, message.body);
        } else if (Number.isInteger(message.id) && typeof message.ok === 'boolean') {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          if (message.ok) pending.resolve(message.result);
          else pending.reject(new Error(message.error?.message ?? '엔진 요청 실패'));
        } else throw new Error('응답 형식이 올바르지 않습니다.');
      } catch (error) {
        this.fail(new Error(`엔진 프로토콜 오류: ${error instanceof Error ? error.message : error}`));
      }
    });
    const timer = setTimeout(() => this.fail(new Error('Java 엔진 시작 시간 초과')), 15000);
    try {
      const hello = await this.send<{ protocolVersion: number }>('hello', {});
      if (hello.protocolVersion !== 1) throw new Error(`지원하지 않는 엔진 프로토콜: ${hello.protocolVersion}`);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally { clearTimeout(timer); }
  }

  async request<T>(command: string, args: object = {}): Promise<T> {
    await this.ready();
    return this.send<T>(command, args);
  }

  private send<T>(command: string, args: object): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      try {
        this.child!.stdin.write(`${JSON.stringify({ id, command, args })}\n`, error => {
          if (error) this.fail(error);
        });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.child?.kill();
    this.emit('exit', error);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = new Error('Java 엔진 연결이 닫혔습니다.');
    for (const request of this.pending.values()) request.reject(this.closed);
    this.pending.clear();
    const child = this.child;
    if (child) {
      child.stdin.end(); // EOF cancels execution and closes device files in the engine.
      const timer = setTimeout(() => child.kill(), 1000);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }
    this.emit('exit', this.closed);
  }
}

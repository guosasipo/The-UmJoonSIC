import * as vscode from 'vscode';
import { EngineClient } from './engineClient';
import { createEngine } from './java';
import { modeFor } from './projects';
import type { AnalysisResult, Diagnostic } from './protocol';
import { translateAssemblerMessage } from './diagnosticMessages';

export class Diagnostics implements vscode.Disposable {
  readonly collection = vscode.languages.createDiagnosticCollection('umjoonsic');
  private client?: Promise<EngineClient>;
  private timers = new Map<string, NodeJS.Timeout>();
  private revisions = new WeakMap<vscode.TextDocument, number>();
  private queued = new Map<string, vscode.TextDocument>();
  private automaticRunning = false;
  private disposed = false;
  private reportedError = '';

  constructor(private context: vscode.ExtensionContext, private output: vscode.OutputChannel) {}

  async engine(automatic = false): Promise<EngineClient> {
    if (this.client) return this.client;
    const pending = createEngine(this.context, this.output, automatic).then(client => {
      if (this.disposed) { client.dispose(); throw new Error('확장이 종료되었습니다.'); }
      client.once('exit', () => { if (this.client === pending) this.client = undefined; });
      return client;
    }).catch(error => { if (this.client === pending) this.client = undefined; throw error; });
    this.client = pending;
    return pending;
  }

  publish(diagnostics: Diagnostic[], documents: readonly vscode.TextDocument[]): void {
    for (const document of documents) {
      const entries = diagnostics.filter(item => item.uri === document.uri.toString()).map(item => {
        const start = document.positionAt(Math.max(0, item.offset));
        const end = document.positionAt(Math.max(0, item.offset) + Math.max(1, item.length));
        const result = new vscode.Diagnostic(new vscode.Range(start, end), translateAssemblerMessage(item.message, vscode.env.language),
          item.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
        result.source = 'UmJoonSIC';
        return result;
      });
      this.collection.set(document.uri, entries);
    }
  }

  schedule(document: vscode.TextDocument): void {
    if (this.disposed) return;
    const key = document.uri.toString();
    this.revisions.set(document, (this.revisions.get(document) ?? 0) + 1);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.queued.delete(key);
    if (!this.enabled(document)) {
      this.collection.delete(document.uri);
      return;
    }
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.queued.set(key, document);
      void this.drain();
    }, 400));
  }

  private enabled(document: vscode.TextDocument): boolean {
    return !this.disposed && !document.isClosed && document.languageId === 'umjoonsic' && document.uri.scheme !== 'debug' &&
      vscode.workspace.isTrusted && vscode.workspace.getConfiguration('umjoonsic', document).get('diagnostics', true);
  }

  private async drain(): Promise<void> {
    if (this.automaticRunning) return;
    this.automaticRunning = true;
    try {
      // The engine handles requests serially. Keep only the latest waiting edit per document.
      while (!this.disposed && this.queued.size) {
        const [key, document] = this.queued.entries().next().value!;
        this.queued.delete(key);
        try { await this.analyze(document, true); }
        catch (error) {
          if (!this.enabled(document)) continue;
          const message = error instanceof Error ? error.message : String(error);
          if (message !== this.reportedError) this.output.appendLine(message);
          this.reportedError = message;
        }
      }
    } finally { this.automaticRunning = false; }
  }

  async analyze(document: vscode.TextDocument, automatic = false): Promise<void> {
    const revision = this.revisions.get(document);
    const current = () => !this.disposed && !document.isClosed && (!automatic || this.enabled(document) && this.revisions.get(document) === revision);
    if (!current()) return;
    const version = document.version, mode = modeFor(document), text = document.getText();
    if (text.length > 1_000_000) { this.collection.delete(document.uri); return; }
    const engine = await this.engine(automatic);
    if (!current()) return;
    const result = await engine.request<AnalysisResult>('analyze', { mode, sources: [{ uri: document.uri.toString(), text }] });
    if (current() && document.version === version && modeFor(document) === mode) {
      this.publish(result.diagnostics, [document]);
      this.reportedError = '';
    }
  }

  close(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.revisions.set(document, (this.revisions.get(document) ?? 0) + 1);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.queued.delete(key);
    this.collection.delete(document.uri);
  }

  reset(): void {
    const previous = this.client;
    this.client = undefined;
    void previous?.then(client => client.dispose()).catch(() => {});
    for (const document of vscode.workspace.textDocuments) this.schedule(document);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.queued.clear();
    void this.client?.then(client => client.dispose()).catch(() => {});
    this.collection.dispose();
  }
}

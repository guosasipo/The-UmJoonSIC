import type { Mode } from './language';

export interface Source { uri: string; text: string }
export interface Diagnostic { uri: string; offset: number; length: number; message: string; severity: 'error' | 'warning' }
export interface ListingRow {
  uri: string; line: number; column: number; length: number; address: number; size: number;
  bytes: string; source: string; section: string; instruction: string; operand: string;
  label: string; executable: boolean; nixbpe: string;
}
export interface ProgramSymbol {
  name: string; uri: string; line: number; address: number; size: number;
  elementSize: number; count: number; type: string; section: string;
}
export interface AnalysisResult { success: boolean; diagnostics: Diagnostic[] }
export interface AssemblyResult extends AnalysisResult {
  entry: number; rows: ListingRow[];
  symbols: ProgramSymbol[]; artifacts: { name: string; content: string }[];
  segments: { address: number; bytes: string }[];
}
export interface Snapshot {
  pc: number; state: 'paused' | 'running' | 'halted' | 'failed'; reason?: string; message?: string;
  stepCount?: number; rate?: number; deviceVersion?: number;
  lastWrite?: { address: number; size: number; pc: number; step: number };
  registers: { A: number; X: number; L: number; B: number; S: number; T: number; SW: number; PC: number; F: string; FHex: string };
}
export interface DeviceState {
  index: number; filename?: string;
  read: string; written: string; readCount: number; writtenCount: number;
  tests: number; notReady: number; eof: boolean; position: number; lastActivityStep: number;
  input?: { address: number; bytes: string; length: number; error?: string };
}
export interface DeviceResult { devices: DeviceState[]; limit: number }
export interface LaunchArguments {
  mode: Mode; sources: Source[]; programs?: string[]; mainSection?: string;
  fileDevices?: { index: number; filename: string }[]; stepDelayMs?: number; stopOnEntry?: boolean;
}
export interface LoadResult { assembly: AssemblyResult; snapshot: Snapshot }

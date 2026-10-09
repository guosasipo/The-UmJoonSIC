import type { ListingRow, ProgramSymbol, Source } from './protocol';
import { getExportedSymbols, type Mode } from './language';
import instructions from './instructions.json';

export type DisplayListingRow = Omit<ListingRow, 'address'> & {
  address?: number; comment: string; raw?: string; instructionBinary: string; rawCodeBinary: string; operandSymbols?: string[];
};
const opcodes = new Map(instructions.sicxe.map(entry => [entry.name, entry]));

export function resolveListingSymbol(row: Pick<ListingRow, 'uri' | 'section'>, name: string, symbols: ProgramSymbol[], sources: Source[], mode: Mode): ProgramSymbol | undefined {
  const candidates = symbols.filter(symbol => symbol.name === name);
  const local = candidates.find(symbol => symbol.uri === row.uri && symbol.section === row.section);
  if (local) return local;
  const exported = sources.flatMap(source => getExportedSymbols(source.text, mode).map(symbol => ({ ...symbol, uri: source.uri })));
  return candidates.find(symbol => symbol.name === symbol.section || exported.some(item => item.uri === symbol.uri && item.section === symbol.section && item.name === symbol.name));
}

function instructionBinary(row: ListingRow): string {
  const entry = row.executable && opcodes.get(row.instruction.replace(/^\+/, ''));
  if (!entry || entry.opcode === null || row.bytes.length < 2) return '';
  const width = entry.format.startsWith('F3') && (parseInt(row.bytes.slice(0, 2), 16) & 3) !== 0 ? 6 : 8;
  return (width === 6 ? entry.opcode >> 2 : entry.opcode).toString(2).padStart(width, '0');
}

export function buildListingRows(rows: ListingRow[], sources: Source[] = []): DisplayListingRow[] {
  const display = (row: ListingRow): DisplayListingRow => ({
    ...row,
    address: row.instruction ? row.address : undefined,
    // The assembler's operand boundary already accounts for quotes and decimal points.
    comment: row.instruction ? row.source.slice(row.column + row.length).trim() : row.source.trim(),
    instructionBinary: instructionBinary(row),
    operandSymbols: opcodes.get(row.instruction.replace(/^\+/, ''))?.format === 'F3m'
      ? /^[#@]?([\p{L}_][\p{L}\p{N}_]*)(?:,X)?$/u.exec(row.operand)?.slice(1)
      : ['BASE', 'END', 'EQU', 'ORG', 'EXTREF', 'EXTDEF'].includes(row.instruction)
        ? [...row.operand.matchAll(/(?<![\p{L}\p{N}_])[\p{L}_][\p{L}\p{N}_]*/gu)].map(match => match[0]) : undefined,
    rawCodeBinary: (row.bytes.slice(0, 64).match(/[0-9a-f]{2}/gi) ?? [])
      .map(byte => parseInt(byte, 16).toString(2).padStart(8, '0')).join(' ') + (row.bytes.length > 64 ? ' …' : ''),
  });
  if (!sources.length) return rows.map(display);
  const result: DisplayListingRow[] = [];
  const included = new Set<ListingRow>();
  for (const source of sources) {
    const byLine = new Map<number, ListingRow[]>();
    for (const row of rows.filter(row => row.uri === source.uri)) {
      byLine.set(row.line, [...(byLine.get(row.line) ?? []), row]);
    }
    const lines = source.text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    lines.forEach((text, line) => {
      const assembled = byLine.get(line);
      if (assembled) {
        for (const row of assembled) { result.push(display(row)); included.add(row); }
      } else {
        const comment = text.trimStart().startsWith('.') ? text.trim() : '';
        result.push({
          uri: source.uri, line, column: 0, length: text.length, size: 0,
          bytes: '', source: text, section: '', instruction: '', operand: '', label: '',
          executable: false, nixbpe: '', comment, raw: comment ? undefined : text,
          instructionBinary: '', rawCodeBinary: '',
        });
      }
    });
  }
  // Generated assembler rows can fall outside the physical source lines.
  result.push(...rows.filter(row => !included.has(row)).map(display));
  return result;
}

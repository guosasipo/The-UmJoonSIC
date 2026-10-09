package sic.common;

/**
 * Pure SIC formats.
 * XE-only formats removed; operands restricted per pure SIC rules.
 */
public enum Format {

    F3,        // 3-byte op without operand (e.g., RSUB)
    F3m,       // 3-byte op with memory operand (symbol/decimal, optional ,X)
    De,        // decimal numeric operand (e.g., WORD n, RESB n, RESW n)
    Se,        // START address: hex digits without prefix
    Sd;        // BYTE C'…' or X'…'

}

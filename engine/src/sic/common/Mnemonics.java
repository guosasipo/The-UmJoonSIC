package sic.common;

import java.util.*;

/**
 * Pure SIC mnemonic table (no XE).
 * - Only format 3 (no format 1/2/4).
 * - Only X indexing is allowed elsewhere in the assembler; this table
 *   just enumerates legal mnemonics for pure SIC.
 */
public class Mnemonics {

    public final Map<String, Mnemonic> map;

    public Mnemonics() {
        this.map = new HashMap<String, Mnemonic>();
        initMnemonics();
    }

    public Mnemonic get(String name) {
        if (map.containsKey(name)) return map.get(name);
        return null;
    }

    public void put(Mnemonic mnemonic) {
        map.put(mnemonic.name, mnemonic);
    }

    public void put(String name, int opcode, Format format) {
        put(new Mnemonic(name, opcode, format));
    }

    /**
     * In pure SIC there is no Format 4. Keep this method name so callers
     * don’t need to change, but only register the F3 variant.
     */
    public void put34(String name, int opcode) {
        put(new Mnemonic(name, opcode, Format.F3m));
        // NO "+name" / Format.F4m in pure SIC
    }

    public void initMnemonics() {
        // ===== Directives (pure SIC only) =====
        put("START",   Opcode.START,  Format.De);
        put("END",     Opcode.END,    Format.De);
        put("RESB",    Opcode.RESB,   Format.Se);
        put("RESW",    Opcode.RESW,   Format.Se);
        put("BYTE",    Opcode.BYTE,   Format.Sd);
        put("WORD",    Opcode.WORD,   Format.Sd);

        // ===== Load & Store =====
        put34("LDA",   Opcode.LDA);
        put34("LDCH",  Opcode.LDCH);
        put34("LDL",   Opcode.LDL);
        put34("LDX",   Opcode.LDX);
        put34("STA",   Opcode.STA);
        put34("STCH",  Opcode.STCH);
        put34("STL",   Opcode.STL);
        put34("STX",   Opcode.STX);
        put34("STSW",  Opcode.STSW);

        // ===== Fixed-point & Logic (mem) =====
        put34("ADD",   Opcode.ADD);
        put34("SUB",   Opcode.SUB);
        put34("MUL",   Opcode.MUL);
        put34("DIV",   Opcode.DIV);
        put34("COMP",  Opcode.COMP);
        put34("AND",   Opcode.AND);
        put34("OR",    Opcode.OR);
        put34("TIX",   Opcode.TIX);

        // ===== Jumps & Subroutines =====
        put34("J",     Opcode.J);
        put34("JEQ",   Opcode.JEQ);
        put34("JGT",   Opcode.JGT);
        put34("JLT",   Opcode.JLT);
        put34("JSUB",  Opcode.JSUB);
        put("RSUB",    Opcode.RSUB, Format.F3);

        // ===== I/O =====
        put34("RD",    Opcode.RD);
        put34("WD",    Opcode.WD);
        put34("TD",    Opcode.TD);

        // NOTE: Everything else (F1/F2 ops, floating point ops, BASE/ORG/EXT*, etc.) intentionally omitted for pure SIC.
    }
}

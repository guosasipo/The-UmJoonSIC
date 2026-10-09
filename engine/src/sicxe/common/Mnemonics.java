package sicxe.common;

import java.util.*;

/**
 * TODO: write a short description
 *
 * @author jure
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

    public void put34(String name, int opcode) {
        put(new Mnemonic(name, opcode, Format.F3m));
        put(new Mnemonic("+" + name, opcode, Format.F4m));
    }

    public void initMnemonics() {
        // Directives
        put("START",   Opcode.START,  Format.De);
        put("END",     Opcode.END,    Format.De);

        put("CSECT",   Opcode.CSECT,  Format.D);
        put("USE",     Opcode.USE,    Format.Ds0);
        put("EXTREF",  Opcode.EXTREF, Format.Ds_);
        put("EXTDEF",  Opcode.EXTDEF, Format.Ds_);

        put("ORG",     Opcode.ORG,    Format.De0);
        put("LTORG",   Opcode.LTORG,  Format.D);

        put("BASE",    Opcode.BASE,   Format.De);
        put("NOBASE",  Opcode.NOBASE, Format.D);

        put("EQU",     Opcode.EQU,    Format.De);
        // Storage directives
        put("RESB",    Opcode.RESB,  Format.Se);
        put("RESW",    Opcode.RESW,  Format.Se);
        put("RESF",    Opcode.RESF,  Format.Se);
        put("BYTE",    Opcode.BYTE,  Format.Sd);
        put("WORD",    Opcode.WORD,  Format.Sd);
        put("FLOT",    Opcode.FLOT,  Format.Sd);
        // Format 1 map, no operand
        put("FIX",     Opcode.FIX,   Format.F1);
        put("FLOAT",   Opcode.FLOAT, Format.F1);
        put("NORM",    Opcode.NORM,  Format.F1);
        put("SIO",     Opcode.SIO,   Format.F1);
        put("HIO",     Opcode.HIO,   Format.F1);
        put("TIO",     Opcode.TIO,   Format.F1);
        // Format 2 map, one or two operands
        put("SVC",     Opcode.SVC,    Format.F2n);
        put("CLEAR",   Opcode.CLEAR,  Format.F2r);
        put("TIXR",    Opcode.TIXR,   Format.F2r);
        put("SHIFTL",  Opcode.SHIFTL, Format.F2rn);
        put("SHIFTR",  Opcode.SHIFTR, Format.F2rn);
        put("ADDR",    Opcode.ADDR,   Format.F2rr);
        put("SUBR",    Opcode.SUBR,   Format.F2rr);
        put("MULR",    Opcode.MULR,   Format.F2rr);
        put("DIVR",    Opcode.DIVR,   Format.F2rr);
        put("COMPR",   Opcode.COMPR,  Format.F2rr);
        put("RMO",     Opcode.RMO,    Format.F2rr);
        // Load and store
        put34("LDA",   Opcode.LDA);
        put34("LDCH",  Opcode.LDCH);
        put34("LDB",   Opcode.LDB);
        put34("LDF",   Opcode.LDF);
        put34("LDL",   Opcode.LDL);
        put34("LDS",   Opcode.LDS);
        put34("LDT",   Opcode.LDT);
        put34("LDX",   Opcode.LDX);
        put34("LPS",   Opcode.LPS);
        put34("STA",   Opcode.STA);
        put34("STCH",  Opcode.STCH);
        put34("STB",   Opcode.STB);
        put34("STF",   Opcode.STF);
        put34("STL",   Opcode.STL);
        put34("STS",   Opcode.STS);
        put34("STT",   Opcode.STT);
        put34("STX",   Opcode.STX);
        put34("STI",   Opcode.STI);
        put34("STSW",  Opcode.STSW);
        // fixed point operations, register-memory
        put34("ADD",   Opcode.ADD);
        put34("SUB",   Opcode.SUB);
        put34("MUL",   Opcode.MUL);
        put34("DIV",   Opcode.DIV);
        put34("COMP",  Opcode.COMP);
        put34("AND",   Opcode.AND);
        put34("OR",	   Opcode.OR);
        put34("TIX",   Opcode.TIX);
        // floating point arithmetic
        put34("ADDF",  Opcode.ADDF);
        put34("SUBF",  Opcode.SUBF);
        put34("MULF",  Opcode.MULF);
        put34("DIVF",  Opcode.DIVF);
        put34("COMPF", Opcode.COMPF);
        // jumps
        put34("J",     Opcode.J);
        put34("JEQ",   Opcode.JEQ);
        put34("JGT",   Opcode.JGT);
        put34("JLT",   Opcode.JLT);
        put34("JSUB",  Opcode.JSUB);
        put("RSUB",    Opcode.RSUB, Format.F3);
        // IO
        put34("RD",	   Opcode.RD);
        put34("WD",	   Opcode.WD);
        put34("TD",	   Opcode.TD);
        // System
        put34("SSK",   Opcode.SSK);
    }

}

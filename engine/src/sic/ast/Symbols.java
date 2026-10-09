package sic.ast;

import sic.asm.AsmError;
import sic.asm.Location;
import sic.ast.storage.StorageData;
import sic.ast.storage.StorageRes;

import java.util.*;

/**
 * Symbol table
 *
 * @author jure
 */
public class Symbols {

    private int maxLength;                          // max length of a symbol name
    private Map<String, Symbol> syms;               // symbol table

    public Symbols() {
        this.maxLength = 6;
        this.syms = new HashMap<String, Symbol>();
    }

    @Override
    public String toString() {
        StringBuilder buf = new StringBuilder();
        for (Map.Entry<String, Symbol> e : syms.entrySet()) {
            buf.append(e.getKey());
            buf.append('=');
            buf.append(e.getValue().value());
            buf.append(',');
        }
        return buf.toString();
    }

    public int maxLength() {
        return maxLength;
    }

    public List<Symbol> asSortedList() {
        List<Symbol> s = new ArrayList<Symbol>(syms.values());
        Collections.sort(s);
        return s;
    }

    // ************ getting info about symbols

    public Symbol get(String name) {
        return syms.get(name);
    }

    public boolean isDefined(String name) {
        return syms.containsKey(name);
    }

    // ************ adding symbols

    // general use
    private void define(Symbol sym) throws AsmError {
        if (sym.name == null || "".equals(sym.name)) return;
        if (isDefined(sym.name))
            throw new AsmError(sym.loc, sym.name.length(), "Duplicate symbol '%s'", sym.name);
        if (sym.name.length() > maxLength) maxLength = sym.name.length();
        syms.put(sym.name, sym);
    }

    // for labels
    public void defineLabel(String name, Location loc, int val, Command command) throws AsmError {
        Symbol symbol;

        if (command instanceof StorageRes || command instanceof StorageData) {
            symbol = new StorageSymbol(name, loc, val, command);
        } else {
            symbol = new Symbol(name, loc, val, false);
        }

        define(symbol);
    }

}

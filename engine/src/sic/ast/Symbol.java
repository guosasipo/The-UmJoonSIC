package sic.ast;

import sic.asm.Location;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class Symbol extends Node implements Comparable<Symbol> {

    enum LabelType { CODE, DATA }

    public final String name;
    public final Location loc;
    public final LabelType labelType;
    private final int value;

    public Symbol(String name, Location loc, int value, boolean isData) {
        this.name = name;
        this.loc = loc;
        this.value = value;
        this.labelType = isData ? LabelType.DATA : LabelType.CODE;
    }

    @Override
    public int compareTo(Symbol that) {
        return name.compareTo(that.name);
    }

    @Override
    public String toString() {
        return name + "=" + value;
    }

    public String labelTypeToString() {
        return labelType.toString().toLowerCase();
    }

    public int value() {
        return value;
    }
}

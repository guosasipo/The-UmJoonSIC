package sic.common;

/**
 * Flags for pure SIC (no XE features).
 *
 * Rules enforced here:
 * - Only simple/SIC addressing; no immediate '#' or indirect '@'.
 * - Only X indexing is allowed; no BASE/PC relative; no EXTENDED.
 * - Instruction encoding must zero ni bits and use SIC 15-bit address field.
 *
 * @author jure (modified for pure SIC)
 */
public class Flags {

    public static final int INDEXED = 0x80;

    private int xbpe;       // only X bit is meaningful in pure SIC

    public Flags(int xbpe) {
        this.xbpe = xbpe & INDEXED;
    }

    public Flags() {
        this(0);
    }

    @Override
    public String toString() {
        // Represent pure SIC ("si"), plus only X in xbpe; no b/p/e.
        return "si" + (isIndexed() ? "x" : "-") + "---";
    }

    /**
     * Stringify an operand with optional ,X.
     * (#/@ are not allowed in pure SIC)
     */
    public String operandToString(String operand) {
        return isIndexed() ? (operand + ",X") : operand;
    }

    /**
     * In pure SIC, the lower two bits are always 0.
     */
    public byte combineWithOpcode(int opcode) {
        return (byte) (opcode & 0xFC);
    }

    // ************ xbpe (only X) ************

    public int get_x() {
        return xbpe & INDEXED;
    }

    public boolean isIndexed() {
        return (xbpe & INDEXED) == INDEXED;
    }

    public void setIndexed() {
        xbpe |= INDEXED;
    }

    // ************ operands (pure SIC addressing field) ************

    /**
     * Pure SIC 15-bit address (no PC/base relative).
     */

}

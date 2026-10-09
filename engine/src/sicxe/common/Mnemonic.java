package sicxe.common;

/**
 * Base abstract class for map.
 *
 * @author jure
 */
public class Mnemonic {

    public final String name;        // name of the mnemonic
    public final int opcode;         // operation code
    public final Format format;      // operand format

    public Mnemonic(String name, int opcode, Format format) {
        this.name = name;
        this.opcode = opcode;
        this.format = format;
    }

    @Override
    public String toString() {
        return name;
    }

    public boolean isExtended() {
        return name.startsWith("+");
    }

}

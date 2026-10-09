package sicxe.ast.instructions;

import sicxe.asm.Location;
import sicxe.common.Mnemonic;

/**
 * Instruction in Format 2.
 *
 * @author jure
 */
public class InstructionF2n extends InstructionF2Base {

    public final int number;

    public InstructionF2n(Location loc,
                          String label, Location labelLocation,
                          Mnemonic mnemonic, Location mnemonicLocation,
                          int number) {
        super(loc, label, labelLocation, mnemonic, mnemonicLocation);
        this.number = number;
    }

    @Override
    public String operandToString() {
        return Integer.toString(number);
    }

    @Override
    public void emitRawCode(byte[] data, int loc) {
        emitRawCode(data, loc, number, 0);
    }

}

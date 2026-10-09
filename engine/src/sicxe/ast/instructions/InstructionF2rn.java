package sicxe.ast.instructions;

import sicxe.asm.Location;
import sicxe.common.Mnemonic;
import sicxe.common.Conversion;

/**
 * Instruction in Format 2.
 *
 * @author jure
 */
public class InstructionF2rn extends InstructionF2Base {

    public final int register;
    public final int number;

    public InstructionF2rn(Location loc,
                           String label, Location labelLocation,
                           Mnemonic mnemonic, Location mnemonicLocation,
                           int register,
                           int number) {
        super(loc, label, labelLocation, mnemonic, mnemonicLocation);
        this.register = register;
        this.number = number;
    }

    @Override
    public String operandToString() {
        return Conversion.regToName(register) + "," + Integer.toString(number);
    }

    @Override
    public void emitRawCode(byte[] data, int loc) {
        emitRawCode(data, loc, register, number - 1);
    }

}

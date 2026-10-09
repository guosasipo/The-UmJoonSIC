package sicxe.ast.instructions;

import sicxe.asm.Location;
import sicxe.common.Flags;
import sicxe.common.Mnemonic;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class InstructionF3 extends Instruction {

    private final Flags flags;

    public InstructionF3(Location loc, String label, Location labelLocation,
                         Mnemonic mnemonic, Location mnemonicLocation) {
        this(loc, label, labelLocation, mnemonic, mnemonicLocation, new Flags(Flags.SIMPLE, Flags.NONE));
    }

    public InstructionF3(Location loc, String label, Location labelLocation,
                         Mnemonic mnemonic, Location mnemonicLocation, Flags flags) {
        super(loc, label, labelLocation, mnemonic, mnemonicLocation);
        this.flags = flags;
    }

    @Override
    public String operandToString() {
        return "";
    }

    @Override
    public int size() {
        return !flags.isSic() && flags.isExtended() ? 4 : 3;
    }

    @Override
    public void emitRawCode(byte[] data, int loc) {
        data[loc]     = flags.combineWithOpcode(mnemonic.opcode);
        data[loc + 1] = (byte) flags.get_xbpe();
        data[loc + 2] = 0;
        if (size() == 4) data[loc + 3] = 0;
    }

}

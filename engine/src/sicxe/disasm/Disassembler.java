package sicxe.disasm;

import sicxe.asm.Location;
import sicxe.common.*;
import sicxe.ast.instructions.*;
import sicxe.sim.vm.Machine;

/**
 * TODO: write a short description
 *
 * @author jure
 */
public class Disassembler {

    private final Mnemonics mnemonics;
    private final Machine machine;

    public Disassembler(Mnemonics mnemonics, Machine machine) {
        this.mnemonics = mnemonics;
        this.machine = machine;
    }

    private int fetchAddr;
    protected int fetch() {
        if (fetchAddr < 0) return 0;
        if (fetchAddr > SICXE.MAX_ADDR) return 0;
        return machine.memory.getByteRaw(fetchAddr++);
    }

    public Instruction disassemble(int addr) {
        this.fetchAddr = addr;
        int opcode = fetch();
        String name = Opcode.getName(opcode & 0xFC);
        if (name == null) return null;
        Mnemonic mnemonic = mnemonics.get(name);
        if (mnemonic == null) return null;
        // The low bits are part of the opcode in formats 1 and 2.
        if ((opcode & 3) != 0 && switch (mnemonic.format) {
            case F1, F2n, F2r, F2rn, F2rr -> true;
            default -> false;
        }) return null;
        int b1, b2;
        Location loc = new Location(-1,-1,-1);
        switch (mnemonic.format) {
            case F1:
                return new InstructionF1(loc, "", null,
                        mnemonic, null);
            case F2n:
                return new InstructionF2n(loc, "", null,
                        mnemonic, null,
                        fetch() >> 4);
            case F2r:
                return new InstructionF2r(loc, "", null,
                        mnemonic, null,
                        fetch() >> 4);
            case F2rn:
                b1 = fetch();
                return new InstructionF2rn(loc, "", null,
                        mnemonic, null,
                        (b1 & 0xF0) >> 4,
                        (b1 & 0x0F) + 1);
            case F2rr:
                b1 = fetch();
                return new InstructionF2rr(loc, "", null,
                        mnemonic, null,
                        (b1 & 0xF0) >> 4,
                        b1 & 0x0F);
            case F3:
                Flags returnFlags = new Flags(opcode, fetch());
                fetch();
                if (!returnFlags.isSic() && returnFlags.isExtended()) {
                    if (returnFlags.isRelative()) return null;
                    fetch();
                }
                return new InstructionF3(loc, "", null,
                        mnemonic, null, returnFlags);
            case F3m:
            case F4m:
                b1 = fetch(); b2 = fetch();
                Flags flags = new Flags(opcode, b1);
                if (flags.isSic()) {
                    int operand = flags.operandSic(b1, b2);
                    flags.set_xbpe(flags.get_x()); // The other bits belong to the 15-bit address.
                    return new InstructionF3m(loc, "", null, mnemonic, null, flags, operand, null, null);
                }
                if (flags.isExtended()) {
                    int operand = flags.operandF4(b1, b2, fetch());
                    mnemonic = mnemonics.get("+" + name);
                    return new InstructionF4m(loc, "", null,
                            mnemonic, null,
                            flags, operand,
                            null, null);
                }
                int operand = flags.operandF3(b1, b2);
                if (flags.isPCRelative()) operand = flags.operandPCRelative(operand);
                return new InstructionF3m(loc, "", null,
                        mnemonic, null,
                        flags, operand,
                        null, null);
        }
        return null;
    }

}

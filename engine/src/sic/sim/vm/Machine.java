package sic.sim.vm;

import iodevices.Devices;
import sic.common.*;

import java.util.Stack;

/**
 * Pure SIC machine: only 3-byte instructions with optional ,X indexing.
 * No F1/F2/F4, no immediate/indirect/base/PC-relative, no float ops.
 *
 * @author jure
 */
public class Machine {

    public static final int MAX_ADDRESS = (1 << 15) - 1; // SIC has a 15-bit address space
    public static final int MAX_DEVICE = 255;

    // ************ Machine parts

    public final Registers registers;
    public final Memory memory;
    public final Devices devices;
    public int lastWriteAddress, lastWriteSize;

    // ************ Statistics

    private Stack<Integer> addressBelowJSUB = new Stack<>();

    // ************ Constructor

    public Machine() {
        this.registers = new Registers();
        this.memory = new Memory(MAX_ADDRESS + 1);
        this.devices = new Devices(MAX_DEVICE + 1);
    }

    // ********** Execution helpers *********************

    private void invalidOpcode(int opcode) {
        throw new IllegalArgumentException(String.format("Invalid opcode 0x%02X", opcode));
    }

    // Effective address in pure SIC: absolute 15-bit address plus optional ,X
    private int effectiveAddr(Flags flags, int addr) {
        if (flags.isIndexed()) {
            addr += registers.getXs();
        }
        return addr;
    }

    // loads/stores (pure SIC: always memory operand; no immediate/indirect)
    private int loadWord(Flags flags, int addr15) {
        int addr = effectiveAddr(flags, addr15);
        return memory.getWord(addr);
    }

    private int loadByte(Flags flags, int addr15) {
        int addr = effectiveAddr(flags, addr15);
        return memory.getByte(addr);
    }

    private void storeWord(Flags flags, int addr15, int word) {
        int addr = effectiveAddr(flags, addr15);
        memory.setWord(addr, word);
        lastWriteAddress = addr; lastWriteSize = 3;
    }

    private void storeByte(Flags flags, int addr15, int _byte) {
        int addr = effectiveAddr(flags, addr15);
        memory.setByte(addr, _byte);
        lastWriteAddress = addr; lastWriteSize = 1;
    }

    // ********** Fetch/Execute *********************

    public int fetch() {
        int b = memory.getByteRaw(registers.getPC());
        registers.incPC();
        return b;
    }

    public void execute() {
        lastWriteSize = 0;

        // Pure SIC: always 3 bytes
        int b0 = fetch(); // opcode (ni=00 already)
        int b1 = fetch(); // x bit in MSB, high 7 bits of address
        int b2 = fetch(); // low 8 bits of address

        Flags flags = new Flags(b1); // our Flags keeps only X from b1
        if ((b0 & 3) != 0) invalidOpcode(b0);
        int opcode = b0 & 0xFC;
        int addr15 = ((b1 & 0x7F) << 8) | (b2 & 0xFF);

        if (execSIC(opcode, flags, addr15)) {
            return;
        }

        invalidOpcode(b0);
    }

    private boolean execSIC(int opcode, Flags flags, int operandAddr) {
        switch (opcode) {
            // ***** stores *****
            case Opcode.STA: storeWord(flags, operandAddr, registers.getA()); break;
            case Opcode.STX: storeWord(flags, operandAddr, registers.getX()); break;
            case Opcode.STL: storeWord(flags, operandAddr, registers.getL()); break;
            case Opcode.STCH: storeByte(flags, operandAddr, registers.getA()); break;
            case Opcode.STSW: storeWord(flags, operandAddr, registers.getSW()); break;

            // ***** jumps *****
            case Opcode.JEQ:
                if (registers.isEqual())
                    registers.setPC(effectiveAddr(flags, operandAddr));
                break;
            case Opcode.JGT:
                if (registers.isGreater())
                    registers.setPC(effectiveAddr(flags, operandAddr));
                break;
            case Opcode.JLT:
                if (registers.isLower())
                    registers.setPC(effectiveAddr(flags, operandAddr));
                break;
            case Opcode.J:
                registers.setPC(effectiveAddr(flags, operandAddr));
                break;
            case Opcode.RSUB:
                registers.setPC(registers.getL());
                popJSUB();
                break;
            case Opcode.JSUB:
                registers.setL(registers.getPC());
                pushJSUB();
                registers.setPC(effectiveAddr(flags, operandAddr));
                break;

            // ***** loads *****
            case Opcode.LDA: registers.setA(loadWord(flags, operandAddr)); break;
            case Opcode.LDX: registers.setX(loadWord(flags, operandAddr)); break;
            case Opcode.LDL: registers.setL(loadWord(flags, operandAddr)); break;
            case Opcode.LDCH: registers.setALo(loadByte(flags, operandAddr)); break;

            // ***** arithmetic & logic *****
            case Opcode.ADD:
                registers.setA(registers.getA() + loadWord(flags, operandAddr));
                break;
            case Opcode.SUB:
                registers.setA(registers.getA() - loadWord(flags, operandAddr));
                break;
            case Opcode.MUL:
                registers.setA(registers.getA() * loadWord(flags, operandAddr));
                break;
            case Opcode.DIV: {
                int divisor = SICXE.swordToInt(loadWord(flags, operandAddr));
                if (divisor == 0) {
                    throw new ArithmeticException("Division by zero");
                } else {
                    registers.setA(registers.getAs() / divisor);
                }
                break;
            }
            case Opcode.AND:
                registers.setA(registers.getA() & loadWord(flags, operandAddr));
                break;
            case Opcode.OR:
                registers.setA(registers.getA() | loadWord(flags, operandAddr));
                break;
            case Opcode.COMP:
                registers.setSWAfterCompare(registers.getAs() - SICXE.swordToInt(loadWord(flags, operandAddr)));
                break;
            case Opcode.TIX: {
                int value = SICXE.swordToInt(loadWord(flags, operandAddr));
                registers.setX(registers.getX() + 1);
                registers.setSWAfterCompare(registers.getXs() - value);
                break;
            }

            // ***** I/O *****
            case Opcode.RD:
                registers.setALo(devices.read(loadByte(flags, operandAddr)));
                break;
            case Opcode.WD:
                devices.write(loadByte(flags, operandAddr), registers.getALo());
                break;
            case Opcode.TD:
                registers.setSWAfterCompare(devices.test(loadByte(flags, operandAddr)) ? -1 : 0);
                break;

            default:
                return false;
        }
        return true;
    }

    // ********** Step over functionality *****************

    /** Push the address below current JSUB to the stack, so we can step out later. */
    private void pushJSUB() {
        this.addressBelowJSUB.push(this.registers.getPC());
    }

    /** Pop the last address below current JSUB (on RSUB). */
    private void popJSUB() {
        if (!this.addressBelowJSUB.isEmpty()) this.addressBelowJSUB.pop();
    }

    /**
     * Get the address below the last JSUB executed, so we can step out.
     * @return null if no item on stack - no JSUB encountered, otherwise last address.
     */
    public int getCallDepth() { return addressBelowJSUB.size(); }

    public Integer getAddressBelowLastJSUB() {
        if (this.addressBelowJSUB.isEmpty()) return null;
        else return this.addressBelowJSUB.peek();
    }
}

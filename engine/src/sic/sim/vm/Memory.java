package sic.sim.vm;

/**
 * Memory
 * @author jure
 */
public class Memory {

    public final byte[] memory;


    public Memory(int capacity) {
        this.memory = new byte[capacity];
    }

    /**
     * Checks if the address is inside memory bounds
     * @throws IllegalArgumentException if the address is outside memory
     */
    private void checkAddress(int address) {
        if (address < 0 || address >= memory.length)
            throw new IllegalArgumentException("Invalid memory address: " + address);
    }

    // ----------------------------------------------
    // Checked memory access methods
    // ----------------------------------------------

    public int getByte(int address) {
        checkAddress(address);
        return ((int)memory[address]) & 0xFF;
    }

    public void setByte(int address, int value) {
        checkAddress(address);
        memory[address] = (byte)(value & 0xFF);
    }

    public int getWord(int address) {
        checkAddress(address);
        checkAddress(address + 2);
        return getByte(address + 2) | getByte(address + 1) << 8 | getByte(address) << 16;
    }

    public void setWord(int address, int value) {
        checkAddress(address);
        checkAddress(address + 2);
        setByte(address, value >> 16);
        setByte(address + 1, value >> 8);
        setByte(address + 2, value);
    }

    // ----------------------------------------------------
    // Raw access for instruction fetch and debugger reads
    // ----------------------------------------------------
    // Useful for the user parts of simulator, like:
    // - screens
    // - watches

    public int getByteRaw(int address) {
        checkAddress(address);
        return ((int)memory[address]) & 0xFF;
    }

}

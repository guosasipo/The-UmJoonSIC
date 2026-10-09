package sic.common;

/**
 * Pure SIC computer specifications (15-bit address space).
 * Conversions between SIC types and Java types.
 *
 * NOTE: Class name and package kept as-is for compatibility with existing code.
 *       Addresses now adhere to SIC's 15-bit (32KB) memory model.
 *
 * @author jure (modified for pure SIC)
 */
public class SICXE {

    /* SIC types:
     * addr (15-bit):           0 .. 0x7FFF
     * word (24-bit):           0 .. 0xFFFFFF
     * sword (signed 24-bit):   -0x800000 .. 0x7FFFFF
     * data: bytes of data
     */

    // ************ addresses: SIC 15-bit memory (32 KB)

    // Primary memory model now uses SIC limits everywhere:
    public static final int SIZE_MEM  = 1 << 15;   // 32 KB
    public static final int MASK_ADDR = 0x7FFF;
    public static final int MIN_ADDR  = 0;
    public static final int MAX_ADDR  = SIZE_MEM - 1;

    public static int intToAddr(int val) {
        return val & MASK_ADDR;
    }

    public static boolean isAddr(int val) {
        return MIN_ADDR <= val && val <= MAX_ADDR;
    }

    // ************ words: unsigned and signed (unchanged for SIC)

    public static final int MASK_WORD = 0xFFFFFF;
    public static final int MAX_WORD  = (1 << 24) - 1;

    // if val < 0, returns two's complement within 24 bits
    public static int intToWord(int val) {
        if (val >= 0) return val & MASK_WORD;
        return ~(-val - 1) & MASK_WORD;
    }

    public static final int MASK_SWORD = 0x7FFFFF;
    public static final int MIN_SWORD  = -(1 << 23);
    public static final int MAX_SWORD  = (1 << 23) - 1;

    public static int swordToInt(int val) {
        if (val <= MAX_SWORD) return val;
        return -(~val & MASK_SWORD) - 1;
    }

    // ************ data (array of bytes) initializers

    public static byte[] intToDataWord(int val) {
        byte[] data = new byte[3];
        data[0] = (byte)((val >> 16)  & 0xFF);
        data[1] = (byte)((val >> 8)   & 0xFF);
        data[2] = (byte)(val & 0xFF);
        return data;
    }

    // ************ devices (unchanged)
}

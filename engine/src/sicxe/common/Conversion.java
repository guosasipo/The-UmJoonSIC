package sicxe.common;

/**
 * Various conversions from SIC/XE to Java/Hex/...
 * @author jure
 */
public class Conversion {

    // ************ sic <-> hex conversions

    public static byte[] hexToBytes(String str) {
        return java.util.HexFormat.of().parseHex(str);
    }

    public static String bytesToHex(byte[] data, int pos, int len) {
        return java.util.HexFormat.of().withUpperCase().formatHex(data, pos, Math.min(pos + len, data.length));
    }

    public static String bytesToHex(byte[] data) {
        return bytesToHex(data, 0, data.length);
    }

    // ************ initalized data to string

    // initalized data to 1,2,3 (float)
    public static String dataToFloat(byte[] data) {
        StringBuilder buf = new StringBuilder(3 * data.length);
        int i = 0;
        while (i < data.length - 5) {
            long num = ((data[i] & 0xFFL) << 40) | ((data[i+1] & 0xFFL) << 32) | ((data[i+2] & 0xFFL) << 24) |
                      ((data[i+3] & 0xFFL) << 16) | ((data[i+4] & 0xFFL) << 8) | (data[i+5] & 0xFFL);
            buf.append(SICXE.bitsToFloat(num));
            if (i < data.length - 6) buf.append(',');
            i += 6;
        }
        return buf.toString();
    }

    // ************ register index <-> name

    public static String regToName(int i) {
        final String[] regs = {"A", "X", "L", "B", "S", "T", "F" };
        try {
            return regs[i];
        } catch (ArrayIndexOutOfBoundsException e) {
            return "?";
        }
    }

    public static int nameToReg(char name) {
        return "AXLBSTF".indexOf(name);
    }

}

package sic.common;

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

}

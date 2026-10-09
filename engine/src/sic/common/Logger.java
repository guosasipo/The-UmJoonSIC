package sic.common;

/**
 * @author: jure
 */
public class Logger {

    public static void err(String msg) {
        final StackTraceElement[] ste = Thread.currentThread().getStackTrace();
        String method = ste[ste.length - 1].getMethodName();
        System.err.println(method + ": " + msg);
    }

    public static void fmterr(String fmt, Object... params) {
        err(String.format(fmt, params));
    }

}

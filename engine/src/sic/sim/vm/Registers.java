package sic.sim.vm;

import sic.common.Logger;
import sic.common.SICXE;

/**
 * Registers of the SIC/XE machine.
 * @author jure
 */
public class Registers {

    // SIC commands counter
    private int PC;
    // SIC 24-bit registers
    private int A, X, L;
    // condition code of status word register
    private int CC;     // TODO: full status word support

    // ***** getters/setters ********************
    // get   ... unsigned
    // get_s ... signed

    public int getPC() {
        return PC;
    }

    public void setPC(int val) {
        PC = SICXE.intToAddr(val);
    }

    public void incPC() {
        if (++PC > Machine.MAX_ADDRESS) {
            Logger.fmterr("PC register overflow.");
            PC = 0;
        }
    }

    public int getA() {
        return A;
    }

    public int getAs() {
        return SICXE.swordToInt(A);
    }

    public void setA(int val) {
        A = SICXE.intToWord(val);
    }

    public int getALo() {
        return A & 0xFF;
    }

    public void setALo(int value) {
        A = A & 0xFFFF00 | value & 0xFF;
    }

    public int getX() {
        return X;
    }

    public int getXs() {
        return SICXE.swordToInt(X);
    }

    public void setX(int val) {
        X = SICXE.intToWord(val);
    }

    public int getL() {
        return L;
    }

    public void setL(int val) {
        L = SICXE.intToWord(val);
    }

    public int getS() {
        return 0;
    }

    public int getT() {
        return 0;
    }

    public int getB() {
        return 0;
    }

    public double getF() {
        return 0;
    }

    public int getSW() {
        if (CC == 0) return 0;
        else if (CC < 0) return 0x40;
        else return 0x80;
    }

    public boolean isLower() {
        return CC < 0;
    }

    public boolean isEqual() {
        return CC == 0;
    }

    public boolean isGreater() {
        return CC > 0;
    }

    public void setSWAfterCompare(int compare) {
        CC = compare;
    }

    public void reset() {
        PC = 0;
        A = X = L = 0;
        CC = 0;
    }

    public Registers() {
        reset();
    }

}

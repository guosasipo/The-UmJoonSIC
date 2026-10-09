package sicxe.link.section;

import sicxe.link.LinkerError;
import sicxe.link.visitors.SectionVisitor;

public class ERecord {
    private long startAddr;

    public ERecord(long startAddr) {
        this.startAddr = startAddr;
    }

    public long getStartAddr() {
        return startAddr;
    }

    @Override
    public String toString() {
        return "ERecord{" +
                "startAddr=" + startAddr +
                '}';
    }

}

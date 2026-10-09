package sicxe.link.section;

import sicxe.link.LinkerError;
import sicxe.link.visitors.SectionVisitor;

/**
 * Text record
 */
public class TRecord {

    private long startAddr;
    private long length;
    private String text;

    public TRecord(long startAddr, long length, String text) {
        this.startAddr = startAddr;
        this.length = length;
        this.text = text;
    }

    public long getStartAddr() {
        return startAddr;
    }

    public void setStartAddr(long startAddr) {
        this.startAddr = startAddr;
    }

    public long getLength() {
        return length;
    }

    public String getText() {
        return text;
    }

    public void setText(String text) {
        this.text = text;
    }

    public boolean contains(long addr) {
        return (addr >= startAddr && addr < startAddr+length);
    }

    @Override
    public String toString() {
        return "TRecord{" +
                "startAddr=" + startAddr +
                ", length=" + length +
                ", text='" + text + '\'' +
                '}';
    }

    public void accept(SectionVisitor visitor) throws LinkerError {
        visitor.visit(this);
    }
}

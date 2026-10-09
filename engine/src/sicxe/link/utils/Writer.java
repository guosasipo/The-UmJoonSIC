package sicxe.link.utils;

import sicxe.link.LinkerError;
import sicxe.link.section.*;

import java.io.PrintWriter;

/*
 * Writes object records to a caller-owned Writer.
 *
 * if skipExt is set to true, it will skip any external symbols and M records referencing them
 */
public class Writer {
    private static final String PHASE = "writer";

    private Section section;

    public Writer (Section section) {
        this.section = section;
    }

    public void write(java.io.Writer output) throws LinkerError {
        PrintWriter writer = new PrintWriter(output);

        if (section.getName().length() > 6)
            section.setName(section.getName().substring(0,6));

        // header
        writer.print("H");
        writer.printf("%-6s", section.getName());
        writer.printf("%06X", section.getStart());
        writer.printf("%06X", section.getLength());
        writer.print('\n');

        //text records
        if (section.getTRecords() != null)
            for (TRecord t : section.getTRecords()) {
                writer.print("T");
                writer.printf("%06X", t.getStartAddr());
                writer.printf("%02X", t.getLength());
                writer.print(t.getText());
                writer.print('\n');
            }

        //modification records
        if (section.getMRecords() != null)
            for (MRecord m : section.getMRecords()) {
                writer.print("M");
                writer.printf("%06X", m.getStart());
                writer.printf("%02X", m.getLength());

                if (m.getSymbol() != null) {
                    if (m.isPositive())
                        writer.print("+");
                    else
                        writer.print("-");

                    writer.print(m.getSymbol());
                }
                writer.print('\n');
            }

        // in some cases we keep some references or definitions
        if (section.getExtDefs() != null && section.getExtDefs().size() > 0) {
            writer.print("D");
            int count = 0;
            for (ExtDef d : section.getExtDefs()) {
                writer.printf("%-6s", d.getName());
                writer.printf("%06X", d.getCsAddress() + d.getAddress());
                writer.print(" ");
                count++;
                if (count % 6 == 0 && count < section.getExtDefs().size()) {
                    writer.print('\n');
                    writer.print("D");
                }
            }
            writer.print('\n');
        }

        if (section.getExtRefs() != null)
            for (ExtRef r : section.getExtRefs()){
                writer.print("R");
                writer.printf("%-6s", r.getName());
                writer.print('\n');
            }

        if (section.getERecord() != null) {
            writer.print("E");
            writer.printf("%06X", section.getERecord().getStartAddr());
            writer.print('\n');
        }

        writer.flush();
        if (writer.checkError()) throw new LinkerError(PHASE, "Unable to write object records");
    }

}

package sicxe.link.visitors;

import sicxe.link.LinkerError;
import sicxe.link.section.*;

import java.util.ArrayList;
import java.util.Map;

/*
 * Second pass
 *  changes Text records according to Modification Records
 */
public class SecondPassVisitor extends SectionVisitor {

    private static final String PHASE = "second pass";

    private final Map<String, ExtDef> esTable;
    private final String progname;

    private Section currSection = null;

    public SecondPassVisitor(String progname, Map<String, ExtDef> esTable) {
        this.progname = progname;
        this.esTable = esTable;
    }

    private TRecord findRecord(long address) {
        var records = currSection.getTRecords();
        if (records == null) return null;
        int low = 0, high = records.size();
        while (low < high) {
            int mid = (low + high) >>> 1;
            if (records.get(mid).getStartAddr() <= address) low = mid + 1;
            else high = mid;
        }
        return low > 0 && records.get(low - 1).contains(address) ? records.get(low - 1) : null;
    }

    @Override
    public void visit(Section section) throws LinkerError {
        currSection = section;

        // visit all mRecords
        if (section.getMRecords() != null) {
            for (MRecord mRecord : section.getMRecords()) {
                mRecord.accept(this);
            }
        }
    }

    @Override
    public void visit(MRecord mRecord) throws LinkerError {
        if (!mRecord.isResolved()) {
            String location = mRecord.getLocation() == null ? "" : " - " + mRecord.getLocation();
            String reference = mRecord.getSymbol() == null ? currSection.getName() : mRecord.getSymbol();
            ExtDef symbol = esTable.get(reference);
            if (symbol == null)
                throw new LinkerError(PHASE, mRecord.getSymbol() + " is not defined in any section " + location);

            long fixAddressStart = mRecord.getStart() + currSection.getStart();
            long fixAddressEnd = fixAddressStart + (mRecord.getLength() - 1) / 2;

            // Validate the entire span before changing any of its records.
            var records = new ArrayList<TRecord>();
            var text = new StringBuilder();
            for (long address = fixAddressStart; address <= fixAddressEnd;) {
                TRecord record = findRecord(address);
                if (record == null)
                    throw new LinkerError(PHASE, "Address " + address + " is not present in any T Record" + location);
                if (record.getText().length() != record.getLength() * 2)
                    throw new LinkerError(PHASE, "Incorrect text length in T Record at " + record.getStartAddr() + location);
                records.add(record);
                text.append(record.getText());
                address = record.getStartAddr() + record.getLength();
            }

            // Offset inside first T-record TEXT (in half-bytes)
            int startNibble = (int) (fixAddressStart - records.get(0).getStartAddr()) * 2;
            startNibble += mRecord.getLength() % 2;
            // We are patching 'len' half-bytes
            final int len = mRecord.getLength();

            String oldHalfBytes = text.substring(startNibble, startNibble + len);

            // Compute corrected value
            long corrected = Long.decode("0x" + oldHalfBytes); // half-bytes, not necessarily aligned
            long symbolValue = symbol.getCsAddress() + symbol.getAddress();
            corrected += mRecord.isPositive() ? symbolValue : -symbolValue;
            corrected &= (1L << (len * 4)) - 1;
            String newHalfBytes = String.format("%0" + len + "X", corrected);

            text.replace(startNibble, startNibble + len, newHalfBytes);
            int offset = 0;
            for (TRecord record : records) {
                int end = offset + record.getText().length();
                record.setText(text.substring(offset, end));
                offset = end;
            }

            // mark M-record as processed and make start absolute (to keep your original behavior)
            mRecord.setSymbol(progname);
            mRecord.setResolved(true);
            mRecord.setStart(mRecord.getStart() + currSection.getStart());
        }
        // A section or external symbol can have the same name as the output program.
    }
}

package sicxe.link.utils;

import sicxe.link.LinkerError;
import sicxe.link.section.*;

import java.io.BufferedReader;
import java.io.Reader;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/*
 * Parser for .obj files
 * "input" identifies the source of the object records in diagnostics
 * parse() returns a list of Sections in the input file
 */
public class Parser {
    private static final String PHASE = "parser";

    private String input;
    private int row;

    public Parser(String input) {
        this.input = input;
    }

    public List<Section> parse(Reader inputReader) throws LinkerError {

        List<Section> sects = new ArrayList<>();

        try (BufferedReader reader = new BufferedReader(inputReader)) {
            Section currSect = null;

            char c = (char) reader.read();
            row = 0;

            while (c != (char)-1) {
                switch (c) {
                    case 'H':

                        // add current section to the list
                        if (currSect != null) {
                            sects.add(currSect);
                        }

                        // start a new section
                        String h = reader.readLine();
                        row++;

                        if (h.length() == 18) {
                            try {

                                String name = h.substring(0, 6).replace(" ", "");
                                long start = Long.decode("0x" + h.substring(6, 12));
                                long length = Long.decode("0x" + h.substring(12, 18));

                                if (start != 0)
                                    throw new LinkerError(PHASE, "The section " + name + " is not relative.", new Location(input, row));

                                currSect = new Section(name, start, length);
                                currSect.setLocation(new Location(input, row));

                            } catch (NumberFormatException nfe) {
                                throw new LinkerError(PHASE, "Wrong H record format",  new Location(input, row));
                            }

                        } else {
                            throw new LinkerError(PHASE, "H record has incorrect length", new Location(input, row));
                        }

                        c = (char) reader.read();
                        break;
                    case 'E':
                        if (currSect == null) throw new LinkerError(PHASE, "Missing H record", new Location(input, row));
                        String e = reader.readLine();
                        row++;

                        long startAddr = Long.decode("0x" + e);

                        ERecord eRecord = new ERecord(startAddr);
                        currSect.setERecord(eRecord);

                        // add section to the list
                        sects.add(currSect);

                        currSect = null;

                        c = (char) reader.read();
                        break;
                    case 'T':
                        if (currSect == null) throw new LinkerError(PHASE, "Missing H record", new Location(input, row));

                        String t = reader.readLine();
                        row++;

                        long tStart = Long.decode("0x" + t.substring(0,6));
                        long tLength = Long.decode("0x" + t.substring(6,8));
                        String text = t.substring(8);

                        TRecord tRecord = new TRecord(tStart, tLength, text);
                        currSect.addTRecord(tRecord);

                        // read next char
                        c = (char) reader.read();
                        break;
                    case 'M':
                        if (currSect == null) throw new LinkerError(PHASE, "Missing H record", new Location(input, row));

                        String m = reader.readLine();
                        row++;

                        long mStart = Long.decode("0x" + m.substring(0,6));
                        long mLength = Long.decode("0x" + m.substring(6,8)); // number of hex chars, not bytes

                        boolean direction = true;
                        String symbol = null;

                        // if adding/substracting an ext symbol
                        if (m.length() > 8) {
                            direction = m.charAt(8) == '+';
                            symbol = m.substring(9).replace(" ", "");
                        } else {
                            direction = true;
                            symbol = currSect.getName();
                        }

                        MRecord mRecord = new MRecord(mStart, (int) mLength, direction, symbol);
                        mRecord.setLocation(new Location(input, row));
                        currSect.addMRecord(mRecord);

                        // read next char
                        c = (char) reader.read();
                        break;
                    case 'R':
                        if (currSect == null) throw new LinkerError(PHASE, "Missing H record", new Location(input, row));

                        String r = reader.readLine();
                        row++;

                        for (int i=0; i<r.length(); i+=6) {
                            String sym = r.substring(i, i+6).replace(" ", "");

                            ExtRef extRef = new ExtRef(sym);
                            currSect.addExtRef(extRef);
                        }

                        c = (char) reader.read();
                        break;
                    case 'D':
                        if (currSect == null) throw new LinkerError(PHASE, "Missing H record", new Location(input, row));

                        String d = reader.readLine();
                        row++;

                        //TODO: check if there should be spaces between symbols

                        for (int i=0; i<d.length()-1; i+=12) {
                            if (d.charAt(i) == ' ') {
                                // jump over the space
                                i++;
                            }
                            String sym = d.substring(i, i+6).replace(" ", "");

                            long symAddr = Long.decode("0x" + d.substring(i+6, i+12));

                            ExtDef extDef = new ExtDef(sym, symAddr);
                            extDef.setLocation(new Location(input, row));
                            currSect.addExtDef(extDef);
                        }
                        c = (char) reader.read();
                        break;
                    case '\n':
                        c = (char) reader.read();
                        row++;
                        break;

                    default:
                        throw new LinkerError(PHASE, "Unexpected character '" + c + "' while reading object file", new Location(input, row));
                }
            }

            // add the last section if it hasn't been closed by ERecord already
            if (currSect != null)
                sects.add(currSect);

            return sects;

        } catch (IOException e) {
            throw new LinkerError(PHASE, "IO exception while reading the file " + input + ".");
        }
    }

}

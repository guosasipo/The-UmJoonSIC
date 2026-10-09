package sicxe.link.section;

import sicxe.link.LinkerError;

import java.util.*;

/*
 * A list of sections in a class
 */
public class Sections {

    private List<Section> sections;
    private Map<String, Section> map;
    private String name;

    public Sections () {
        this.sections = new ArrayList<>();
        this.map = new HashMap<>();
    }

    public void addSection(Section section) throws LinkerError {

        if (map.get(section.getName()) != null)
            throw new LinkerError("sections", "Duplicated section name: " + section.getName(), section.getLocation());
        map.put(section.getName(), section);

        sections.add(section);
    }

    public void addSections(List<Section> sectionList) throws LinkerError {
        for (Section s : sectionList)
            addSection(s);
    }

    public List<Section> getSections() {
        return sections;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public void move(String name, int position) throws LinkerError {
        Section section = null;
        for (Section s : sections)
            if (s.getName().equals(name)) {
                section = s;
                break;
            }

        if (section == null)
            throw new LinkerError("move section", name + " not found");
        else if (position >= sections.size() || position < 0)
            throw new LinkerError("move section", "position " + position + " is out of bounds");
        else {
            sections.remove(section);
            sections.add(position, section);
        }
    }

   /*
    * combines all sections into one
    */
    public Section combine() {
        if (sections == null || sections.size() == 0)
            return null;

        // if sections are not named yet, name them after first section
        if (name == null)
            name = sections.get(0).getName();

        long start = sections.get(0).getStart();
        List<TRecord> tRecords = new ArrayList<>();
        List<MRecord> mRecords = new ArrayList<>();
        List<ExtDef> extDefs = new ArrayList<>();
        List<ExtRef> extRefs = new ArrayList<>();

        for (Section s : sections) {
            tRecords.addAll(s.getTRecords());
            mRecords.addAll(s.getMRecords());
            extRefs.addAll(s.getExtRefs());
        }
        Section last = sections.get(sections.size()-1);
        long length = last.getStart() + last.getLength() - start;

        Section combined = new Section(name, start, length, tRecords, mRecords, extRefs, extDefs, new ERecord(start + (sections.get(0).getERecord() == null ? 0 : sections.get(0).getERecord().getStartAddr())));

        return combined;
    }

    /*
     * cleans out unneccessary ExtRefs
     * removes contradicting M records
     */

    public void clean() {
        // remove M records that contradict eachother

        Map<Long, List<MRecord>> table = new HashMap<>();
        for (Section s : sections) {
            for (MRecord m : s.getMRecords()) {
                // find others related to same address
                List<MRecord> list = table.get(m.getStart());
                if (list == null) {
                    list = new ArrayList<>();
                    list.add(m);
                    table.put(m.getStart(), list);
                } else {
                    ListIterator<MRecord> iterator = list.listIterator();
                    while (iterator.hasNext()) {
                        MRecord existing = iterator.next();

                        // delete both contradicting records
                        if (m.isPositive() && !existing.isPositive() || !m.isPositive() && existing.isPositive()) {
                            m.setDelete(true);
                            existing.setDelete(true);
                            iterator.remove();
                            break;
                        }
                    }
                }
            }

            // The second pass has resolved every external reference.
            s.setExtRefs(new ArrayList<>());
        }

        // delete all mRecords marked as deleted
        for (Section s : sections) {
            ListIterator<MRecord> mIterator = s.getMRecords().listIterator();
            while (mIterator.hasNext()) {
                MRecord m = mIterator.next();

                // TODO: what about the -progname symbols?
                // if symbol is +progname, we can skip it to get cleaner output code
                // this usually simplifies all m records

                if (m.isResolved() && m.isPositive()) {
                    m.setSymbol(null);
                }


                if (m.isDelete())
                    mIterator.remove();
            }
        }

    }
}

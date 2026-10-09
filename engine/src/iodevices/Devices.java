package iodevices;

import java.util.logging.Logger;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.*;
import java.util.*;

public class Devices {

    private static final Logger LOG = Logger.getLogger(Devices.class.getName());

    private Device[] devices;
    public static final int TRACE_LIMIT = 65536;
    private Activity[] activity;
    private long step, version;

    public static final class Snapshot {
        public int index;
        public String filename, read = "", written = "";
        public long readCount, writtenCount, tests, notReady, position, lastActivityStep;
        public boolean eof;
        public FileDevice.Input input;
    }

    private static final class History {
        final byte[] bytes = new byte[TRACE_LIMIT];
        long count;
        void append(int value) { bytes[(int) (count++ % TRACE_LIMIT)] = (byte) value; }
        String hex(int limit) {
            int size = (int) Math.min(count, limit), start = (int) ((count - size) % TRACE_LIMIT);
            byte[] result = new byte[size];
            int first = Math.min(size, TRACE_LIMIT - start);
            System.arraycopy(bytes, start, result, 0, first);
            System.arraycopy(bytes, 0, result, first, size - first);
            return HexFormat.of().withUpperCase().formatHex(result);
        }
    }

    private static final class Activity {
        History read, written;
        long tests, notReady, step;
        boolean eof;
    }

    public void beginInstruction(long step) { this.step = step; }
    public long version() { return version; }

    private Activity record(int index) {
        Activity item = activity[index];
        if (item == null) activity[index] = item = new Activity();
        item.step = step;
        version++;
        return item;
    }

    public List<Snapshot> snapshots(Integer index, int count, boolean preview) {
        if (index != null && (index < 0 || index >= devices.length)) throw new IllegalArgumentException("Device index must be in 0..255");
        if (count < 0 || count > TRACE_LIMIT) throw new IllegalArgumentException("Device byte count must be in 0..65536");
        List<Snapshot> result = new ArrayList<>();
        for (int i = index == null ? 0 : index; i < (index == null ? devices.length : index + 1); i++) {
            if (index == null && activity[i] == null && !(devices[i] instanceof FileDevice)) continue;
            Snapshot item = new Snapshot();
            item.index = i;
            if (devices[i] instanceof FileDevice file) {
                item.filename = file.filename(); item.position = file.position();
                if (count > 0 && preview) item.input = file.preview(count);
            }
            Activity a = activity[i];
            if (a != null) {
                item.tests = a.tests; item.notReady = a.notReady; item.eof = a.eof; item.lastActivityStep = a.step;
                if (a.read != null) { item.readCount = a.read.count; item.read = a.read.hex(count); }
                if (a.written != null) { item.writtenCount = a.written.count; item.written = a.written.hex(count); }
            }
            result.add(item);
        }
        return result;
    }

    public void clearFile(int index) {
        if (index < 0 || index >= devices.length || !(devices[index] instanceof FileDevice))
            throw new IllegalArgumentException("Select a device connected to a file");
        FileDevice target = (FileDevice) devices[index];
        Path path = Path.of(target.filename());
        if (Files.exists(path) && !Files.isRegularFile(path)) throw new IllegalArgumentException("Only regular device files can be cleared");
        try {
            // A removed or replaced path may still have an open handle to this file.
            // Resolve every open connection before creating or truncating anything.
            for (Device device : devices)
                if (device instanceof FileDevice file) file.checkOpenIdentity();
            // Create a missing output without truncating while resolving shared handles.
            try (var channel = Files.newByteChannel(path, StandardOpenOption.CREATE, StandardOpenOption.WRITE)) {}
            List<Integer> shared = new ArrayList<>();
            for (int i = 0; i < devices.length; i++) {
                if (devices[i] instanceof FileDevice file) {
                    try { if (Files.isSameFile(path, Path.of(file.filename()))) shared.add(i); }
                    catch (NoSuchFileException missing) { /* Unopened missing outputs have no shared handle. */ }
                }
            }
            for (int i : shared) if (i != index) devices[i].reset();
            target.clear();
            for (int i : shared) activity[i] = null;
            version++;
        } catch (IOException error) {
            throw new UncheckedIOException("Cannot clear device file: " + target.filename(), error);
        }
    }

    public Device getDevice(int idx) {
        return devices[idx];
    }

    public void setDevice(int idx, Device device) {
        devices[idx] = device;
    }

    public void addFileDevice(int idx, String filePath) {

        devices[idx] = new FileDevice(filePath);
    }


    private boolean checkDeviceIndex(int idx) {
        boolean invalid = idx < 0 || idx >= devices.length;
        if (invalid) LOG.severe(String.format("Invalid device number '%d'.", idx));
        return invalid;
    }

    public int read(int idx) {
        if (checkDeviceIndex(idx)) {
            LOG.severe(String.format("Invalid device number '%d'.", idx));
            return 0;
        }
        int val = devices[idx].read();
        Activity item = record(idx);
        item.eof = val < 0 && devices[idx] instanceof FileDevice;
        if (val < 0 || val > 255) val = 0;
        if (item.read == null) item.read = new History();
        item.read.append(val); item.notReady = 0;
        return val;
    }

    public void write(int idx, int val) {
        if (checkDeviceIndex(idx))
            LOG.severe(String.format("Invalid device number '%d'.", idx));
        else {
            devices[idx].write(val & 0xFF);
            Activity item = record(idx);
            if (item.written == null) item.written = new History();
            item.written.append(val); item.notReady = 0; item.eof = false;
        }
    }

    public boolean test(int idx) {
        if (checkDeviceIndex(idx)) {
            LOG.severe(String.format("Invalid device number '%d'.", idx));
            return false;
        }
        boolean ready = devices[idx].test();
        Activity item = record(idx);
        item.tests++; item.notReady = ready ? 0 : item.notReady + 1;
        return ready;
    }

    public Devices(int count) {
        assert count > 2;
        devices = new Device[count];
        activity = new Activity[count];
        for (int i = 0; i < count; i++)
            setDevice(i, new Device());
    }
}

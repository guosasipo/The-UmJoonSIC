package iodevices;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.io.FileNotFoundException;
import java.io.RandomAccessFile;
import java.util.HexFormat;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.ByteBuffer;

public class FileDevice extends Device {


    private String filename;
    private RandomAccessFile file;
    private Object fileKey;

    public static final class Input {
        public long address, length;
        public String bytes = "", error;
    }

    public String filename() { return filename; }

    public long position() {
        try { return file == null ? 0 : file.getFilePointer(); }
        catch (IOException error) { throw new UncheckedIOException("Cannot read device position: " + filename, error); }
    }

    public Input preview(int count) {
        Input result = new Input();
        try {
            result.address = position();
            if (file != null) readPreview(file, count, result);
            else {
                if (!Files.isRegularFile(Path.of(filename))) throw new IOException("Not a regular file");
                try (RandomAccessFile input = new RandomAccessFile(filename, "r")) { readPreview(input, count, result); }
            }
        } catch (IOException | UncheckedIOException error) {
            result.error = "Cannot preview device file: " + filename;
        }
        return result;
    }

    private static void readPreview(RandomAccessFile input, int count, Input result) throws IOException {
        result.length = input.length();
        byte[] bytes = new byte[(int) Math.min(count, Math.max(0, result.length - result.address))];
        int read = bytes.length == 0 ? 0 : Math.max(0, input.getChannel().read(ByteBuffer.wrap(bytes), result.address));
        result.bytes = HexFormat.of().withUpperCase().formatHex(bytes, 0, read);
    }

    public void clear() {
        if (file == null) openFile();
        try { checkOpenIdentity(); file.setLength(0); file.seek(0); }
        catch (IOException error) { throw new UncheckedIOException("Cannot clear device file: " + filename, error); }
    }

    void checkOpenIdentity() throws IOException {
        if (file == null) return;
        Object current;
        try { current = Files.readAttributes(Path.of(filename), BasicFileAttributes.class).fileKey(); }
        catch (IOException error) {
            throw new IOException("Device file changed; restart before clearing: " + filename, error);
        }
        if (fileKey == null || !fileKey.equals(current))
            throw new IOException("Cannot verify the open device file; restart before clearing: " + filename);
    }

    private void openFile() {
        Object before = null;
        try { before = Files.readAttributes(Path.of(filename), BasicFileAttributes.class).fileKey(); }
        catch (IOException ignored) { /* A missing output can be created by the execution handle. */ }
        try {
            file = new RandomAccessFile(filename, "rw");
        } catch (FileNotFoundException e) {
            throw new UncheckedIOException("Cannot open device file: " + filename, e);
        }
        // Identity is only required for an explicit clear, never for ordinary I/O.
        try {
            Object opened = Files.readAttributes(Path.of(filename), BasicFileAttributes.class).fileKey();
            fileKey = before == null || before.equals(opened) ? opened : null;
        } catch (IOException ignored) { fileKey = null; }
    }

    @Override
    public boolean test(){
        return true;
    }

    @Override
    public int read() {
        if (file == null) openFile();
        try {
            return file.read();
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot read device file: " + filename, e);
        }
    }

    @Override
    public void write(int value) {
        if (file == null) openFile();
        try {
            file.write(value);
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot write device file: " + filename, e);
        }
    }

    @Override
    public void reset() {
        if (file == null) return;
        try {
            file.close();
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot close device file: " + filename, e);
        } finally {
            file = null;
            fileKey = null;
        }
    }

    public FileDevice(String filename) {
        this.filename = filename;
    }
}

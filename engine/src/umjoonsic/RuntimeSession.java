package umjoonsic;

import iodevices.Devices;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

/** One serial owner for the VM, pending instruction and all debugger commands. */
public final class RuntimeSession implements AutoCloseable {
    public static final class FileMapping { public int index; public String filename; }
    public static final class Snapshot {
        public int pc;
        public String state, reason, message;
        public long stepCount, deviceVersion;
        public double rate;
        public LastWrite lastWrite;
        public Map<String, Object> registers;
    }
    public record LastWrite(int address, int size, int pc, long step) {}
    private volatile Thread owner;
    private final ScheduledThreadPoolExecutor worker = new ScheduledThreadPoolExecutor(1, task -> {
        Thread thread = new Thread(task, "umjoonsic-runtime");
        thread.setDaemon(true);
        owner = thread;
        return thread;
    });
    private final Consumer<Snapshot> stopped;
    private final Consumer<Snapshot> progress;
    private long lastProgress;
    private long stepCount, rateTime, rateSteps;
    private long deviceVersionBase = -1;
    private double rate;
    private LastWrite lastWrite;
    private sic.sim.vm.Machine sic;
    private sicxe.sim.vm.Machine xe;
    private String state = "paused", reason = "entry", message;
    private int delayMs = 500;
    private final Set<Integer> breakpoints = new TreeSet<>();
    private ScheduledFuture<?> pending;
    private Integer skipBreakpoint, target;
    private int targetDepth;

    public RuntimeSession(Consumer<Snapshot> stopped, Consumer<Snapshot> progress) {
        this.stopped = stopped;
        this.progress = progress;
        worker.setRemoveOnCancelPolicy(true);
    }

    public <T> T onOwner(Callable<T> operation) throws Exception {
        if (Thread.currentThread() == owner) return operation.call();
        try { return worker.submit(operation).get(); }
        catch (ExecutionException e) {
            if (e.getCause() instanceof Exception cause) throw cause;
            throw new IllegalStateException("Runtime command failed", e.getCause());
        }
    }

    public Snapshot load(String mode, AssemblyService.Result assembly, List<FileMapping> mappings, int delay) throws Exception {
        return onOwner(() -> {
            checkDelay(delay);
            if (!assembly.success) throw new IllegalArgumentException("Cannot load unsuccessful assembly");
            if (!mode.equals("sic") && !mode.equals("sicxe")) throw new IllegalArgumentException("Unknown machine mode");
            int capacity = mode.equals("sic") ? 32768 : 1048576;
            if (assembly.entry < 0 || assembly.entry >= capacity) throw new IllegalArgumentException("Entry address outside memory");
            // Validate everything before replacing the currently loaded machine.
            List<byte[]> data = new ArrayList<>();
            for (AssemblyService.Segment segment : assembly.segments) {
                byte[] bytes = HexFormat.of().parseHex(segment.bytes);
                if (segment.address < 0 || segment.address > capacity - bytes.length)
                    throw new IllegalArgumentException("Object segment outside memory");
                data.add(bytes);
            }
            Set<Integer> seen = new HashSet<>();
            for (FileMapping mapping : mappings) {
                if (mapping == null || mapping.index < 0 || mapping.index > 255 || !seen.add(mapping.index))
                    throw new IllegalArgumentException("Device indexes must be distinct integers in 0..255");
                if (mapping.filename == null || mapping.filename.isBlank()) throw new IllegalArgumentException("Device filename is required");
            }
            sic.sim.vm.Machine newSic = mode.equals("sic") ? new sic.sim.vm.Machine() : null;
            sicxe.sim.vm.Machine newXe = mode.equals("sicxe") ? new sicxe.sim.vm.Machine() : null;
            byte[] memory = newSic != null ? newSic.memory.memory : newXe.memory.memory;
            for (int i = 0; i < assembly.segments.size(); i++)
                System.arraycopy(data.get(i), 0, memory, assembly.segments.get(i).address, data.get(i).length);
            Devices devices = newSic != null ? newSic.devices : newXe.devices;
            for (FileMapping mapping : mappings) devices.addFileDevice(mapping.index, mapping.filename);
            if (newSic != null) newSic.registers.setPC(assembly.entry); else newXe.registers.setPC(assembly.entry);
            cancelPending();
            long nextDeviceVersion = deviceVersionBase + (loaded() ? devices().version() : 0) + 1;
            try { closeDevices(); }
            catch (RuntimeException error) { finish("failed", "exception", error.getMessage()); throw error; }
            lastProgress = 0;
            deviceVersionBase = nextDeviceVersion;
            stepCount = 0; rate = 0; lastWrite = null;
            sic = newSic; xe = newXe; delayMs = delay;
            breakpoints.clear(); target = null; skipBreakpoint = null;
            state = "paused"; reason = "entry"; message = null;
            return currentSnapshot();
        });
    }

    public Snapshot snapshot() throws Exception { return onOwner(() -> { requireLoaded(); return currentSnapshot(); }); }
    public Snapshot snapshotOrNull() throws Exception { return onOwner(() -> loaded() ? currentSnapshot() : null); }

    public Snapshot step(String kind) throws Exception {
        return onOwner(() -> {
            requirePaused();
            if (!Set.of("in", "over", "out").contains(kind)) throw new IllegalArgumentException("Unknown step kind: " + kind);
            target = null;
            if (kind.equals("out")) {
                target = sic != null ? sic.getAddressBelowLastJSUB() : xe.getAddressBelowLastJSUB();
                if (target == null) throw new IllegalStateException("No tracked subroutine to step out of");
                targetDepth = callDepth() - 1;
            } else if (kind.equals("over") && (memory()[pc()] & 0xFC) == 0x48) {
                target = (pc() + instructionSize(pc())) % memory().length; targetDepth = callDepth();
            }
            if (target != null) {
                skipBreakpoint = pc();
                state = "running"; reason = null; message = null;
                beginRateWindow();
                schedule(0);
            } else {
                executeOne();
                if (!state.equals("failed") && !state.equals("halted")) finish("paused", "step", null);
            }
            return currentSnapshot();
        });
    }

    public Snapshot resume(Integer delay) throws Exception {
        return onOwner(() -> {
            requireLoaded();
            if (delay != null) changeDelay(delay);
            if (state.equals("running")) return currentSnapshot();
            requirePaused();
            skipBreakpoint = "breakpoint".equals(reason) ? pc() : null;
            target = null; state = "running"; reason = null; message = null;
            beginRateWindow();
            schedule(delayMs);
            return currentSnapshot();
        });
    }

    public Snapshot pause() throws Exception {
        return onOwner(() -> {
            requireLoaded();
            if (state.equals("running")) finish("paused", "pause", null);
            return currentSnapshot();
        });
    }

    public Snapshot setDelay(int delay) throws Exception {
        return onOwner(() -> { requireLoaded(); changeDelay(delay); return currentSnapshot(); });
    }
    private void changeDelay(int delay) {
        checkDelay(delay); delayMs = delay;
        if (state.equals("running")) { cancelPending(); schedule(delayMs); }
    }
    private static void checkDelay(int delay) {
        if (delay < 0 || delay > 60000) throw new IllegalArgumentException("delayMs must be an integer in 0..60000");
    }

    public Map<String, Object> setBreakpoints(List<Integer> addresses) throws Exception {
        return onOwner(() -> {
            requireLoaded();
            for (int address : addresses) checkRange(address, 1);
            breakpoints.clear(); breakpoints.addAll(addresses);
            return Map.of("addresses", new ArrayList<>(breakpoints));
        });
    }

    public Map<String, Object> readMemory(int address, int count) throws Exception {
        return onOwner(() -> {
            requireLoaded();
            if (count < 0 || count > 65536) throw new IllegalArgumentException("Memory count must be in 0..65536");
            checkRange(address, count);
            return Map.of("address", address, "bytes", HexFormat.of().withUpperCase().formatHex(memory(), address, address + count));
        });
    }

    public Map<String, Object> devices(Integer index, int count, boolean preview) throws Exception {
        return onOwner(() -> {
            requireLoaded();
            return Map.of("devices", devices().snapshots(index, count, preview), "limit", Devices.TRACE_LIMIT);
        });
    }

    public Snapshot clearDevice(int index) throws Exception {
        return onOwner(() -> {
            requireLoaded();
            if (state.equals("running")) throw new IllegalStateException("Pause the program before clearing a device file");
            devices().clearFile(index);
            return currentSnapshot();
        });
    }

    public Map<String, Object> disassemble(int address, int count) throws Exception {
        return onOwner(() -> {
            requireLoaded(); checkRange(address, 1);
            if (count < 0 || count > 128) throw new IllegalArgumentException("Disassembly count must be in 0..128");
            List<Map<String, Object>> instructions = new ArrayList<>();
            var sicDisassembler = sic == null ? null : new sic.disasm.Disassembler(new sic.common.Mnemonics(), sic);
            var xeDisassembler = xe == null ? null : new sicxe.disasm.Disassembler(new sicxe.common.Mnemonics(), xe);
            int location = address;
            for (int i = 0; i < count && location < memory().length; i++) {
                int size = 1; String instruction = String.format("BYTE X'%02X'", memory()[location] & 255);
                try {
                    if (sic != null) {
                        var cmd = sicDisassembler.disassemble(location);
                        if (cmd != null) { size = cmd.size(); instruction = (cmd.nameToString() + " " + cmd.operandToString()).trim(); }
                    } else {
                        var cmd = xeDisassembler.disassemble(location);
                        if (cmd != null) { size = cmd.size(); instruction = (cmd.nameToString() + " " + cmd.operandToString()).trim(); }
                    }
                    checkRange(location, size);
                } catch (RuntimeException invalid) { size = 1; instruction = String.format("BYTE X'%02X'", memory()[location] & 255); }
                instructions.add(Map.of("address", location, "bytes", HexFormat.of().withUpperCase().formatHex(memory(), location, location + size), "instruction", instruction));
                location += size;
            }
            return Map.of("instructions", instructions);
        });
    }

    private void tick() {
        pending = null;
        if (!state.equals("running")) return;
        // Bounded batches keep pause/terminate responsive even at delay zero.
        int batch = delayMs == 0 ? 128 : 1;
        for (int i = 0; i < batch && state.equals("running"); i++) {
            if (breakpoints.contains(pc()) && !Objects.equals(skipBreakpoint, pc())) {
                finish("paused", "breakpoint", null); return;
            }
            skipBreakpoint = null;
            if (target != null && pc() == target && callDepth() <= targetDepth) {
                finish("paused", "step", null); return;
            }
            executeOne();
        }
        if (state.equals("running")) {
            long now = System.nanoTime();
            if (now - lastProgress >= TimeUnit.MILLISECONDS.toNanos(100)) {
                progress.accept(currentSnapshot());
                lastProgress = System.nanoTime();
            }
            schedule(delayMs);
        }
    }

    private void executeOne() {
        int previous = pc();
        try {
            checkRange(previous, instructionSize(previous));
            devices().beginInstruction(stepCount + 1);
            if (sic != null) sic.execute(); else xe.execute();
            stepCount++;
            int size = sic != null ? sic.lastWriteSize : xe.lastWriteSize;
            if (size > 0) lastWrite = new LastWrite(sic != null ? sic.lastWriteAddress : xe.lastWriteAddress, size, previous, stepCount);
            checkRange(pc(), 1);
            if (pc() == previous) finish("halted", "halt", "Program stopped at a self-jump");
        } catch (Exception error) {
            if (sic != null) sic.registers.setPC(previous); else xe.registers.setPC(previous);
            finish("failed", "exception", error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
        }
    }

    private int instructionSize(int address) {
        if (sic != null) return 3;
        int op = memory()[address] & 255;
        switch (op) {
            case 0xC0, 0xC4, 0xC8, 0xF0, 0xF4, 0xF8: return 1;
            case 0x90, 0x94, 0x98, 0x9C, 0xA0, 0xA4, 0xA8, 0xAC, 0xB0, 0xB4, 0xB8: return 2;
        }
        checkRange(address, 2);
        return (op & 3) != 0 && (memory()[address + 1] & 0x10) != 0 ? 4 : 3;
    }
    private void schedule(int delay) { pending = worker.schedule(this::tick, delay, TimeUnit.MILLISECONDS); }
    private void cancelPending() { if (pending != null) pending.cancel(false); pending = null; }
    private void finish(String nextState, String stopReason, String detail) {
        cancelPending(); state = nextState; reason = stopReason; message = detail; target = null;
        stopped.accept(currentSnapshot());
    }
    private boolean loaded() { return sic != null || xe != null; }
    private void requireLoaded() { if (!loaded()) throw new IllegalStateException("No program is loaded"); }
    private void requirePaused() {
        requireLoaded();
        if (!state.equals("paused")) throw new IllegalStateException("Program is " + state + "; pause or restart before stepping");
    }
    private int pc() { return sic != null ? sic.registers.getPC() : xe.registers.getPC(); }
    private int callDepth() { return sic != null ? sic.getCallDepth() : xe.getCallDepth(); }
    private Devices devices() { return sic != null ? sic.devices : xe.devices; }
    private byte[] memory() { return sic != null ? sic.memory.memory : xe.memory.memory; }
    private void checkRange(int address, int count) {
        if (address < 0 || count < 0 || address > memory().length - count)
            throw new IllegalArgumentException("Memory range outside " + memory().length + " bytes");
    }
    private Snapshot currentSnapshot() {
        Snapshot snapshot = new Snapshot();
        snapshot.pc = pc(); snapshot.state = state; snapshot.reason = reason; snapshot.message = message;
        long elapsed = System.nanoTime() - rateTime;
        if (state.equals("running") && elapsed >= TimeUnit.MILLISECONDS.toNanos(500)) {
            rate = Math.round((stepCount - rateSteps) * 1_000_000_000.0 / elapsed);
            rateSteps = stepCount; rateTime = System.nanoTime();
        }
        snapshot.stepCount = stepCount; snapshot.rate = state.equals("running") ? rate : 0;
        snapshot.lastWrite = lastWrite; snapshot.deviceVersion = deviceVersionBase + devices().version();
        Map<String, Object> r = new LinkedHashMap<>();
        double f;
        if (sic != null) {
            var regs = sic.registers;
            r.put("A", regs.getA()); r.put("X", regs.getX()); r.put("L", regs.getL());
            r.put("B", regs.getB()); r.put("S", regs.getS()); r.put("T", regs.getT());
            r.put("SW", regs.getSW()); f = regs.getF();
        } else {
            var regs = xe.registers;
            r.put("A", regs.getA()); r.put("X", regs.getX()); r.put("L", regs.getL());
            r.put("B", regs.getB()); r.put("S", regs.getS()); r.put("T", regs.getT());
            r.put("SW", regs.getSW()); f = regs.getF();
        }
        r.put("PC", snapshot.pc); r.put("F", Double.toString(f));
        r.put("FHex", String.format("%012X", sicxe.common.SICXE.floatToBits(f) & 0xFFFFFFFFFFFFL));
        snapshot.registers = r;
        return snapshot;
    }

    private void beginRateWindow() { rateTime = System.nanoTime(); rateSteps = stepCount; rate = 0; }

    private void closeDevices() {
        if (!loaded()) return;
        Devices devices = sic != null ? sic.devices : xe.devices;
        RuntimeException failure = null;
        for (int i = 0; i < 256; i++) {
            try { devices.getDevice(i).reset(); }
            catch (RuntimeException error) { if (failure == null) failure = error; else failure.addSuppressed(error); }
        }
        if (failure != null) throw failure;
    }
    public void dispose() throws Exception {
        onOwner(() -> {
            cancelPending();
            try { closeDevices(); }
            finally {
                if (loaded()) deviceVersionBase += devices().version();
                sic = null; xe = null; breakpoints.clear(); target = null; skipBreakpoint = null; state = "paused";
            }
            return null;
        });
    }
    @Override public void close() throws Exception { try { dispose(); } finally { worker.shutdownNow(); } }
}

package umjoonsic;

import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** JSON-lines bridge. Only protocol messages use the original stdout stream. */
public final class Main {
    private final Gson gson = new GsonBuilder().disableHtmlEscaping().create();
    private final PrintWriter output;
    private final AssemblyService compiler = new AssemblyService();
    private final RuntimeSession runtime;
    private List<RuntimeSession.Snapshot> deferredStops;

    private Main(PrintWriter output) {
        this.output = output;
        runtime = new RuntimeSession(snapshot -> {
            if (deferredStops != null) deferredStops.add(snapshot);
            else emit(Map.of("event", "stopped", "body", snapshot));
        }, snapshot -> emit(Map.of("event", "progress", "body", snapshot)));
    }

    public static void main(String[] args) throws Exception {
        PrintWriter protocol = new PrintWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8), true);
        System.setOut(new PrintStream(System.err, true, StandardCharsets.UTF_8));
        Main bridge = new Main(protocol);
        try (BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = input.readLine()) != null) bridge.accept(line);
        } finally { bridge.runtime.close(); }
    }

    private synchronized void emit(Object message) { output.println(gson.toJson(message)); }

    private void accept(String line) throws Exception {
        JsonObject request;
        try {
            JsonElement parsed = JsonParser.parseString(line);
            if (!parsed.isJsonObject()) throw new IllegalArgumentException("Request must be an object");
            request = parsed.getAsJsonObject();
        } catch (RuntimeException error) {
            Map<String, Object> reply = new LinkedHashMap<>();
            reply.put("id", null); reply.put("ok", false); reply.put("error", Map.of("message", errorMessage(error)));
            emit(reply); return;
        }
        // Response and synchronous stop events finish before the next execution tick.
        runtime.onOwner(() -> {
            deferredStops = new ArrayList<>();
            Map<String, Object> reply = new LinkedHashMap<>();
            reply.put("id", request.get("id"));
            try {
                integer(request, "id");
                String command = string(request, "command");
                JsonObject arguments = new JsonObject();
                if (request.has("args")) {
                    if (!request.get("args").isJsonObject()) throw new IllegalArgumentException("args must be an object");
                    arguments = request.getAsJsonObject("args");
                }
                reply.put("result", dispatch(command, arguments)); reply.put("ok", true);
            } catch (Exception error) {
                reply.put("ok", false); reply.put("error", Map.of("message", errorMessage(error)));
            }
            emit(reply);
            List<RuntimeSession.Snapshot> stops = deferredStops;
            deferredStops = null;
            for (RuntimeSession.Snapshot snapshot : stops) emit(Map.of("event", "stopped", "body", snapshot));
            return null;
        });
    }

    private Object dispatch(String command, JsonObject args) throws Exception {
        return switch (command) {
            case "hello" -> Map.of("protocolVersion", 1);
            case "analyze" -> {
                AssemblyService.Result analysis = compiler.analyze(mode(args), sources(args));
                yield Map.of("success", analysis.success, "diagnostics", analysis.diagnostics);
            }
            case "assemble" -> compiler.assemble(mode(args), sources(args), optionalString(args, "mainSection"));
            case "load" -> {
                String mode = mode(args);
                int delay = args.has("stepDelayMs") ? integer(args, "stepDelayMs") : 500;
                if (delay < 0 || delay > 60000) throw new IllegalArgumentException("stepDelayMs must be in 0..60000");
                List<RuntimeSession.FileMapping> devices = fileMappings(args);
                AssemblyService.Result assembly = compiler.assemble(mode, sources(args), optionalString(args, "mainSection"));
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("assembly", assembly);
                result.put("snapshot", assembly.success ? runtime.load(mode, assembly, devices, delay) : runtime.snapshotOrNull());
                yield result;
            }
            case "snapshot" -> runtime.snapshot();
            case "step" -> runtime.step(args.has("kind") ? string(args, "kind") : "in");
            case "continue" -> runtime.resume(args.has("delayMs") ? integer(args, "delayMs") : null);
            case "pause" -> runtime.pause();
            case "setDelay" -> runtime.setDelay(integer(args, "delayMs"));
            case "breakpoints" -> {
                List<Integer> addresses = new ArrayList<>();
                for (JsonElement element : array(args, "addresses")) addresses.add(integer(element, "breakpoint address"));
                yield runtime.setBreakpoints(addresses);
            }
            case "memory" -> runtime.readMemory(integer(args, "address"), integer(args, "count"));
            case "devices" -> {
                boolean preview = true;
                if (args.has("preview")) {
                    JsonElement value = args.get("preview");
                    if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isBoolean()) throw new IllegalArgumentException("preview must be a boolean");
                    preview = value.getAsBoolean();
                }
                yield runtime.devices(args.has("index") ? integer(args, "index") : null, args.has("count") ? integer(args, "count") : 8192, preview);
            }
            case "deviceReset" -> runtime.clearDevice(integer(args, "index"));
            case "disassemble" -> runtime.disassemble(integer(args, "address"), integer(args, "count"));
            case "dispose" -> { runtime.dispose(); yield Map.of(); }
            default -> throw new IllegalArgumentException("Unknown command: " + command);
        };
    }

    private List<AssemblyService.Source> sources(JsonObject args) {
        List<AssemblyService.Source> sources = new ArrayList<>();
        for (JsonElement element : array(args, "sources")) {
            if (!element.isJsonObject()) throw new IllegalArgumentException("Each source must be an object");
            JsonObject source = element.getAsJsonObject();
            string(source, "uri"); string(source, "text");
            sources.add(gson.fromJson(source, AssemblyService.Source.class));
        }
        if (sources.isEmpty()) throw new IllegalArgumentException("At least one source is required");
        return sources;
    }
    private List<RuntimeSession.FileMapping> fileMappings(JsonObject args) {
        List<RuntimeSession.FileMapping> devices = new ArrayList<>();
        if (!args.has("fileDevices")) return devices;
        Set<Integer> indexes = new HashSet<>();
        for (JsonElement element : array(args, "fileDevices")) {
            if (!element.isJsonObject()) throw new IllegalArgumentException("Each file device must be an object");
            JsonObject device = element.getAsJsonObject();
            int index = integer(device, "index");
            if (index < 0 || index > 255 || !indexes.add(index)) throw new IllegalArgumentException("Device indexes must be distinct integers in 0..255");
            String filename = string(device, "filename");
            if (filename.isBlank()) throw new IllegalArgumentException("Device filename must not be blank");
            RuntimeSession.FileMapping mapping = new RuntimeSession.FileMapping();
            mapping.index = index; mapping.filename = filename; devices.add(mapping);
        }
        return devices;
    }
    private static String mode(JsonObject args) {
        String mode = string(args, "mode");
        if (!mode.equals("sic") && !mode.equals("sicxe")) throw new IllegalArgumentException("mode must be sic or sicxe");
        return mode;
    }
    private static JsonArray array(JsonObject object, String name) {
        if (!object.has(name) || !object.get(name).isJsonArray()) throw new IllegalArgumentException(name + " must be an array");
        return object.getAsJsonArray(name);
    }
    private static String optionalString(JsonObject object, String name) {
        return !object.has(name) || object.get(name).isJsonNull() ? null : string(object, name);
    }
    private static String string(JsonObject object, String name) {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString())
            throw new IllegalArgumentException(name + " must be a string");
        return value.getAsString();
    }
    private static int integer(JsonObject object, String name) { return integer(object.get(name), name); }
    private static int integer(JsonElement value, String name) {
        try {
            if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) throw new IllegalArgumentException();
            return value.getAsBigDecimal().intValueExact();
        } catch (RuntimeException error) { throw new IllegalArgumentException(name + " must be an integer"); }
    }
    private static String errorMessage(Exception error) {
        return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    }
}

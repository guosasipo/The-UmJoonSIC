# UmJoonSIC engine

`src/sic`, `src/sicxe` and `src/iodevices` derive from CAPS-DGU/UmJoonSIC
commit `35bba80be645bc07170ba5adcfcc6bcb51a3ca4d` (the SicTools subtree).
`src/umjoonsic` provides the buffer-based assembler facade and JSON-lines runtime.
Both upstream license texts and the bundled Gson license are retained.

## Build and interface

Run `npm run build:engine` from the repository root with JDK 17 or newer.
`UMJOONSIC_JAVAC` can select the compiler. The build verifies the pinned Gson
2.10.1 checksum, compiles with `--release 17`, and produces
`dist/umjoonsic-engine.jar`. The first build downloads Gson from Maven Central;
later builds reuse `engine/.cache` after checksum verification.

The packaged JAR needs Java 17+ and performs no downloads. Its supported entrypoint
is `umjoonsic.Main`; [PROTOCOL.md](PROTOCOL.md) describes its requests, responses
and events. The original CLI entrypoints, Electron application and HTTP server
are not included. Private/internal Java APIs are not compatibility interfaces.

## Assembly and linking

- SIC uses absolute START addresses and rejects overlapping nonempty programs. XE assembles
  and links multiple files or multiple CSECTs in one file, preserving END entry,
  source rows, symbols and control-section placements.
- Diagnostics use UTF-16 source offsets, keep the first identical error, and are
  stable-sorted at result boundaries. Invalid or incomplete input returns a
  diagnostic instead of terminating the process. HEX data and hexadecimal string
  escapes accept only ASCII hexadecimal digits through Java 17 `HexFormat`.
- Expressions give unary signs precedence over multiplication and validate integer
  overflow and relative/absolute EQU semantics. END addresses are checked at their
  operand location during both analysis and assembly.
  ORG validates its counter even at end of input; only an absent operand restores
  the previous counter. Empty dot comments preserve multiline label declarations.
  `*` in EQU binds to its definition location. Absolute EQU cannot be exported
  because D-records do not preserve its absolute attribute.
- Linking checks the shared section/external-symbol namespace, PC/base relocation
  compatibility, and the complete relocated format-4 address. Invalid results
  publish no loadable segments or artifacts. Modular WORD modification records
  remain supported; `PROTOCOL.md` describes the address constraints.
- The linker performs a complete link. Missing symbols are errors; partial-link,
  keep-definition and verbose CLI options are not exposed. Section placements
  are recorded between the first and second passes for listing and range checks.
- Analysis validates encoding without constructing listing/symbol DTOs. Object
  records are processed in memory; modification records use binary search over
  sorted text records and validate the entire affected span before patching it.
  Listing character data uses UTF-8.

## Runtime behavior

- One execution loop owns VM operations, cancellation, pre-execution breakpoints,
  step in/over/out and live delay changes. Progress is capped at 10 Hz; manual
  steps and final states are sent immediately. Halted values remain available.
- Memory reads and writes validate the complete byte/word/float span. SIC uses
  32 KiB and XE uses 1 MiB. Invalid instructions, registers and addressing modes
  produce runtime errors. SIC TIX reads its indexed operand before incrementing X.
  DIVR uses signed operands; RSUB does not depend on the
  optional debugger call-history stack.
- Device activity records actual RD/WD/TD results with bounded 64KiB buffers per direction.
  Read-only previews preserve cursor positions. Explicit clearing resets all handles
  sharing a physical file; launch never truncates it. Step counts, running rate and
  the latest successful memory store are exposed in snapshots.
- File device errors propagate. Restart/dispose close files; restart resets their
  positions but does not undo bytes already written.
- Disassembly preserves three-byte SIC-compatible instructions in XE mode and
  consumes four bytes for raw extended RSUB. Invalid opcodes display as BYTE.
  Source `+RSUB` remains unsupported.
- The original immediate interpretation and IEEE double upper-48-bit float
  representation are retained. Decimal float tokens are converted as a whole
  before storage, avoiding separate integer/fraction rounding. This is not complete textbook SIC/XE float
  conformance. `NORM SIO HIO TIO SVC LPS STI SSK` remain explicitly unsupported.

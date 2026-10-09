# Engine protocol 1

Pinned source: CAPS-DGU/UmJoonSIC `35bba80be645bc07170ba5adcfcc6bcb51a3ca4d`. Source under src/sic, src/sicxe and src/iodevices is vendored and patched locally. Preserve both upstream licenses. No HTTP server is included.

UTF-8 newline-delimited JSON on stdin/stdout. All logging goes to stderr. Requests: `{id:number,command:string,args:object}`. Responses: `{id,ok:true,result}` or `{id,ok:false,error:{message}}`. Notifications: `{event:"stopped",body:Snapshot}` immediately on a stop/step and `{event:"progress",body:Snapshot}` while running (at most 10Hz at every execution speed). Zero-based UTF-16 source offsets and line/column. Diagnostics retain the first occurrence of each distinct `(uri, offset, length, message, severity)` within a compilation; other diagnostics and their order are preserved. Byte strings are contiguous hexadecimal. Shared TypeScript data contracts are in src/protocol.ts.

- hello: returns `{protocolVersion:1}`.
- analyze `{mode,sources}`: `{success:boolean,diagnostics:Diagnostic[]}` only; validates syntax/encoding/address ranges without building listing/symbol DTOs. Does not mutate the VM or access device files; no linking needed.
- assemble `{mode,sources,mainSection?}`: AssemblyResult; no VM mutation. Result artifacts contain filenames/content, not file writes. Object parsing/linking/writing stays in memory.
  EQU expressions retain their absolute/relative meaning through linking;
  invalid relative arithmetic and duplicate external/section names produce
  diagnostics. `*` in EQU refers to that definition's location, including when
  a forward dependency is resolved later.
  HEX data and hexadecimal string escapes accept only ASCII 0-9, A-F and a-f;
  malformed digits return source diagnostics.
  Unary signs bind more tightly than multiplication, division and remainder.
  BASE and NOBASE retain the current instruction location; BASE * evaluates to
  the address of that directive, and labels on either directive use that address.
  Empty dot comments between a label and its instruction preserve the instruction.
  An explicit ORG expression must resolve to 0..0x100000, including at end of input;
  only an omitted expression restores the previous counter. The one-past position
  permits zero-size directives but cannot hold additional bytes.
  Resolved END addresses are range-checked at the operand in both analyze and
  assemble; the final linked entry is checked again after placement.
  Decimal floating-point tokens are parsed once as a complete number, preserving
  the existing upper-48-bit IEEE storage and negative zero.
  Integer expressions reject overflowing intermediate arithmetic, including
  minimum-int division by -1, with a diagnostic at the operator. VM word
  arithmetic and object WORD relocation remain modular. Float range diagnostics
  identify the full numeric source span, including a leading minus sign.
  Unexpected trailing expression tokens produce diagnostics at the consumed
  token; valid dot comments and expression precedence are preserved.
  EXTDEF rejects absolute symbols at their source name because object D-records
  cannot preserve that attribute. Local absolute EQU and relative exports are
  supported. Listing operand strings preserve UTF-8 character data and decode
  the existing stored float bytes without signed-byte corruption.
  Per-source `.log` artifacts count each section's blocks independently of their
  byte lengths, including empty blocks.
  Linking requires every external symbol used by a relocation to resolve. Unused
  EXTREF declarations are allowed. Partial linking and retaining exported
  definitions for a later link are not supported.
  Linking reports source diagnostics for a moved SIC-format relative operand or
  overflow of a 12-bit instruction address; unsuccessful results contain no
  loadable segments or artifacts. Standalone addressing and WORD modular
  relocation are preserved. Internal address-width metadata is not serialized.
  Moved PC/base-relative displacements are rejected when the target and base have
  different relocation behavior, or the BASE expression's relocation is unknown.
  The diagnostic points to the instruction and suggests its extended form.
  In-place execution, sections placed at zero, and matching absolute/relative
  BASE expressions retain their encoding. This placement metadata is not serialized.
  Format-4 source rows validate the full relocated target in 0..0xFFFFF using the
  linked section/export address. Overflow is a diagnostic at the source instruction
  with no artifacts or loadable segments. Absolute operands and generic M-record
  arithmetic (including modular WORD records) are unchanged. Reference metadata
  used for this check is transient and is not serialized.
- load LaunchArguments: returns `{assembly,snapshot}`. On assembly errors return `assembly.success:false` and do not replace an existing VM. Successful load creates a fresh machine and applies file devices. Paused initially.
- snapshot `{}`: Snapshot.
- step `{kind:"in"|"over"|"out"}`: Snapshot and a stopped notification when finished. Over/out may start asynchronous execution; snapshots then report running.
- continue `{delayMs?}`: Snapshot (running), then stopped notification at breakpoint/halt/error. Single loop; first breakpoint checked before execution; on resume skip the current stopped breakpoint once.
- pause `{}`: Snapshot (paused) plus stopped notification. No additional instruction after the response.
- setDelay `{delayMs:number}`: Snapshot. 0..60000ms, next pending instruction uses the new value; 0ms remains interruptible.
- breakpoints `{addresses:number[]}`: replaces all code breakpoints, returns `{addresses}`.
- memory `{address:number,count:number}`: `{address,bytes}`; validate range and count (maximum 65536).
- disassemble `{address:number,count:number}`: `{instructions:[{address:number,bytes:string,instruction:string}]}`; forward decoding, maximum 128 instructions, may return fewer at the memory boundary. SIC-compatible instructions in XE mode remain three bytes; address bits are not interpreted as XE b/p/e flags. Raw extended RSUB uses four bytes, matching the VM; ordinary RSUB remains three bytes and source `+RSUB` is not added. Invalid SIC opcode bits and invalid XE format 1/2 opcodes are returned as one-byte BYTE rows.
- devices `{index?,count?,preview?}`: `{devices,limit:65536}`. Only configured or used devices are returned unless an index is specified. `count` is 0..65536; 0 returns metadata without file reads, positive counts return each direction's recent bytes. `preview:false` omits input file preview. Each device has index, optional filename, read/written hex, readCount/writtenCount, tests, consecutive notReady, eof, position and lastActivityStep. Optional input preview contains file offset `address`, bytes, length and an optional error. Preview uses positional reads on the execution handle when open and a temporary read-only handle otherwise. It never advances the execution cursor or creates a file. EOF reads return and record zero, with eof=true.
- deviceReset `{index}`: requires a connected regular file and a non-running machine. Explicitly clears that file and resets the positions and traces of all devices sharing the same physical file. Before clearing, all open device paths must still identify their opened files. A deleted/replaced path or unavailable file identity rejects the request before any file is cleared or created; ordinary reads/writes and open-file previews remain available. Launch/restart never truncate files. Returns Snapshot.
- dispose `{}`: cancel loop, close devices, release VM; return `{}`. EOF also disposes.

Java compiler facade contract: `AssemblyService.analyze(String mode, List<AssemblyService.Source> sources)` and `AssemblyService.assemble(String mode, List<AssemblyService.Source> sources, String mainSection)` return `AssemblyService.Result`. Analysis leaves output lists empty, and the bridge serializes only success/diagnostics. Assembly public fields match AssemblyResult; nested Source/Diagnostic/Row/Symbol/Artifact/Segment DTOs match protocol fields. The runtime loads Result.segments and entry, retaining rows and symbols for the client. Error input must return diagnostics or structured errors, never System.exit. The supported packaged entrypoint is `umjoonsic.Main`; legacy upstream Java CLI classes are excluded.

DAP layer custom requests: `umjoonsic.listing` returns AssemblyResult, `umjoonsic.snapshot` returns Snapshot, `umjoonsic.memory` forwards memory, `umjoonsic.setDelay` forwards setDelay. Custom event `umjoonsic.state` carries Snapshot; views can refresh without owning execution state. Unsupported data breakpoints and reverse execution are not advertised.

DAP hover requests with source, line and column resolve against the immutable launch source. Symbol declarations and operands use their exact definition; EXTREF follows EXTDEF. Register operands and indexed X retain register meaning. Watch expressions keep the existing bare-register and $register syntax.

DAP breakpoint collections supplied by source path and sourceReference are replaced independently and combined for execution. File aliases resolve to the captured physical source while retaining their separate breakpoint collections and the original launch URI/text. Listing displays and toggles the file aliases and the current session's snapshot breakpoints for each source row.

Snapshots also include stepCount (successfully executed instructions), rate (instructions per second over a running half-second window; zero while paused), a monotonic opaque deviceVersion, and optional lastWrite `{address,size,pc,step}` from the actual VM store operation. Load/restart clear counters, lastWrite and traces; deviceVersion changes so unchanged-register restarts still refresh device data.

DAP custom requests `umjoonsic.devices` and `umjoonsic.deviceReset` forward their matching engine commands. Before a normal disconnect/terminate, the adapter pauses and emits `umjoonsic.devices` with the most recent 8192 bytes per direction for all devices and no file previews. A 750ms deadline preserves forced shutdown if the engine stops responding; in that case only already received view data is retained. Incoming stale controls are rejected during shutdown.

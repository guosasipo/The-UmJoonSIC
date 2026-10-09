# Third-party notices

`src/instructions.json` contains mnemonic names, opcodes, formats, descriptions,
and effects derived from [CAPS-DGU/UmJoonSIC](https://github.com/CAPS-DGU/UmJoonSIC)
at commit [`35bba80be645bc07170ba5adcfcc6bcb51a3ca4d`](https://github.com/CAPS-DGU/UmJoonSIC/tree/35bba80be645bc07170ba5adcfcc6bcb51a3ca4d).
The corresponding TextMate grammar is generated from that metadata. These files
are distributed with the extension; generating them is a maintainer-only step.

Source files: `simulator/SicTools/src/{sic,sicxe}/common/{Mnemonics,Opcode,Format}.java`
and `simulator/SicTools/src/{sic,sicxe}/sim/vm/Machine.java`.
`scripts/generate-language.mjs` reads these files directly from the pinned Git
commit and corrects operand hints against its `asm/parsing/OperandParser.java`:
SIC START uses unprefixed hexadecimal, SIC END takes an optional symbol, XE END
requires an expression, F2 registers exclude PC/SW, instruction operands do not
support `*` or expressions, and WORD does not support symbol expressions or lists.

To regenerate with Node.js and a local upstream Git clone:

```sh
node scripts/generate-language.mjs /path/to/UmJoonSIC
node scripts/generate-language.mjs /path/to/UmJoonSIC --check
```

The upstream project includes the following two notices. Both are retained here
for source and packaged distributions.

The vendored Java source in `engine/src/{sic,sicxe,iodevices}` is derived from
the same commit and contains local correctness and integration patches described
in `engine/README.md`. Both notices also apply to the bundled engine JAR.

The 1.1.0 user-interface changes were compared from commit `0dc6831944861fa95fc0c36190915c10e372ded0`
through `f60ddda604b41cbb17cbbf08ec752a4d57512a7c` and adapted to VS Code APIs.
`src/diagnosticMessages.ts` adapts `app/src/i18n/assemblerMessages.ts` from the latter
commit under the same BSD-2-Clause notice, preserving symbol names in translations.

The engine JAR bundles Google Gson 2.10.1, Copyright Google Inc., under the
Apache License 2.0, reproduced in `engine/GSON-LICENSE.txt`.
The extension includes Microsoft `@vscode/debugadapter` 1.68.0 under MIT;
its `License.txt` and `thirdpartynotices.txt` are included beside the packaged
dependency. `@vscode/debugprotocol` 1.68.0 supplies build-time types under MIT;
its unused JavaScript stub is not distributed in the VSIX.

When no compatible Java installation is available, the extension can download an
official Eclipse Temurin 17 JRE through the [Adoptium API](https://adoptium.net/installation/ci-scripts).
The JRE is installed separately in extension storage and is not bundled in the
VSIX. The archive's `legal/` directory, including its LICENSE and assembly
exception, is preserved. The SHA-256 supplied by the official API is checked
before extraction. Automatic preparation can be disabled in extension settings.

## CAPS-DGU/UmJoonSIC — upstream LICENSE

```text
BSD 2-Clause License

Copyright (c) 2025, Dongguk University Central Club 'CAPS'

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## SicTools — upstream simulator/SicTools/doc/license.txt

```text
Copyright (c) 2015 Jurij Mihelič
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

http://www.opensource.org/licenses/BSD-2-Clause
```

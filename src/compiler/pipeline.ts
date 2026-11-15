// C のファイルたち → コンパイラ → アセンブラ（.o）→ リンカ → 実行ファイル、をまとめて行う
//
// .o の中身（機械語・記号表・再配置表）は、ファイルを1つずつアセンブルして作る。
// ほかのファイルの関数は、そのファイルの中では番地が分からないので、機械語のその部分を 0 にして「再配置表」に書く。
// リンカは、ファイルを並べて置き場所を決め、再配置表に書いた場所の番地を埋める。
// 実際に動かすのは、全部のファイルをつないでアセンブルしたもの（リンクの結果と同じ機械語になることをテストで確かめている）。
import { type Instr, type Program, assemble } from '../core/assembler';
import { DATA_BASE, TEXT_BASE } from '../core/defs';
import { type AsmLine, type CompiledFile, fileBase, generate } from './codegen';
import { CompileError, type Token, tokenize } from './lexer';
import { type Unit, parse } from './parser';

export interface SourceFile {
  name: string;
  source: string;
}

export interface CError {
  line: number;
  col: number;
  message: string;
}

export interface FileResult {
  name: string;
  base: string;
  tokens: Token[] | null;
  unit: Unit | null;
  compiled: CompiledFile | null;
  asmText: string;
  error: CError | null;
  obj: ObjFile | null;
}

export type RelocKind = 'J26' | 'HI16' | 'LO16';

export interface Reloc {
  off: number; // .text の中の位置
  kind: RelocKind;
  symbol: string;
  external: boolean; // ほかのファイルにあるもの
}

export interface ObjInstr {
  off: number;
  word: number; // .o の中の機械語（番地が決まっていないところは 0 または ファイルの中の位置）
  text: string; // 命令の書き方
  asmLine: number; // .s の行（1 から）
  cLine?: number;
  reloc?: Reloc;
  label?: string[]; // この位置のラベル
}

export interface ObjData {
  off: number;
  label: string;
  bytes: number[];
  kind: string;
  global: boolean;
}

export interface ObjSymbol {
  name: string;
  section: '.text' | '.data' | '未定義';
  off: number;
  global: boolean; // ほかのファイルから見える
  kind: '関数' | 'ラベル' | '変数' | '文字列' | '';
}

export interface ObjFile {
  name: string;
  text: ObjInstr[];
  data: ObjData[];
  dataSize: number;
  symbols: ObjSymbol[];
  relocs: Reloc[];
}

export interface LayoutEntry {
  file: string;
  textStart: number;
  textSize: number;
  dataStart: number;
  dataSize: number;
}

export interface Patch {
  file: string;
  addr: number;
  off: number;
  text: string;
  before: number;
  after: number;
  reloc: Reloc;
}

export interface LinkResult {
  ok: boolean;
  errors: string[];
  layout: LayoutEntry[];
  symbols: { name: string; addr: number; file: string; section: '.text' | '.data'; kind: string }[];
  patches: Patch[];
  program: Program | null;
  source: string; // 実行に使うアセンブリ（全部のファイルをつないだもの）
  lineFile: number[]; // source の各行がどのファイルか（行番号 − 1 → ファイルの番号）
  lineC: (number | undefined)[]; // source の各行に対応する C の行
}

export interface BuildResult {
  files: FileResult[];
  link: LinkResult | null;
}

const asmTextOf = (lines: AsmLine[]) => lines.map((l) => l.text).join('\n') + '\n';

/** ファイル1つを .o にする（ほかのファイルの関数は、仮の場所に置いた印で番地を調べ、0 にしておく） */
function buildObj(f: FileResult): ObjFile | null {
  const c = f.compiled!;
  const own = c.asm.length;
  const externals = c.called.filter((n) => !c.defined.includes(n));
  const stub = externals.length ? '\n    .text\n' + externals.map((n) => `${n}: jr $ra`).join('\n') + '\n' : '';
  const prog = assemble(f.asmText + stub);
  // main がないファイル（mathfuncs.c など）も .o にはなる
  if (prog.errors.some((e) => !e.message.includes('main というラベル'))) return null;
  const labelLine = new Map<string, number>();
  f.asmText.split('\n').forEach((t, i) => {
    const m = /^([A-Za-z_.][\w.]*):/.exec(t);
    if (m) labelLine.set(m[1], i + 1);
  });
  const isOwn = (name: string) => labelLine.has(name);
  const dataStart = DATA_BASE;
  const relocs: Reloc[] = [];
  const text: ObjInstr[] = [];
  for (const ins of prog.text) {
    if (ins.line > own) continue;
    const off = ins.addr - TEXT_BASE;
    let word = ins.word;
    let reloc: Reloc | undefined;
    if ((ins.op === 'j' || ins.op === 'jal') && ins.targetLabel) {
      const ext = !isOwn(ins.targetLabel);
      word = ext ? (ins.word & 0xfc000000) >>> 0 : ((ins.word & 0xfc000000) | (((ins.target - TEXT_BASE) >>> 2) & 0x3ffffff)) >>> 0;
      reloc = { off, kind: 'J26', symbol: ins.targetLabel, external: ext };
    } else if (ins.pseudo === 'la' && (ins.op === 'lui' || ins.op === 'ori')) {
      const sym = ins.source.split(',').at(-1)!.trim();
      const addr = prog.labels.get(sym) ?? 0;
      const ext = !isOwn(sym);
      const rel = ext ? 0 : addr - (addr >= DATA_BASE ? dataStart : TEXT_BASE);
      const imm = ins.op === 'lui' ? (rel >>> 16) & 0xffff : rel & 0xffff;
      word = ((ins.word & 0xffff0000) | imm) >>> 0;
      reloc = { off, kind: ins.op === 'lui' ? 'HI16' : 'LO16', symbol: sym, external: ext };
    }
    if (reloc) relocs.push(reloc);
    text.push({
      off,
      word,
      text: reloc ? relocText(ins, reloc) : ins.text,
      asmLine: ins.line,
      cLine: c.asm[ins.line - 1]?.cLine,
      reloc,
      label: prog.textLabels.get(ins.addr)?.filter(isOwn),
    });
  }
  const data: ObjData[] = prog.dataLabels
    .filter((d) => d.line <= own)
    .map((d) => ({
      off: d.addr - dataStart,
      label: d.name,
      bytes: [...prog.data.slice(d.addr - dataStart, d.addr - dataStart + d.size)],
      kind: d.kind,
      global: c.globals.includes(d.name),
    }));
  const symbols: ObjSymbol[] = [];
  for (const [name, addr] of prog.labels) {
    if (!isOwn(name)) continue;
    const isData = addr >= DATA_BASE;
    const fn = c.defined.includes(name);
    symbols.push({
      name,
      section: isData ? '.data' : '.text',
      off: addr - (isData ? dataStart : TEXT_BASE),
      global: fn || c.globals.includes(name),
      kind: isData ? (c.globals.includes(name) ? '変数' : '文字列') : fn ? '関数' : 'ラベル',
    });
  }
  for (const n of externals) symbols.push({ name: n, section: '未定義', off: 0, global: true, kind: '関数' });
  symbols.sort((a, b) => order(a) - order(b) || a.off - b.off);
  return { name: `${f.base}.o`, text, data, dataSize: prog.data.length, symbols, relocs };
}

function order(s: ObjSymbol) {
  return s.section === '.text' ? (s.global ? 0 : 1) : s.section === '.data' ? 2 : 3;
}

function relocText(ins: Instr, r: Reloc): string {
  if (r.kind === 'J26') return `${ins.op} ${r.symbol}`;
  const reg = ins.text.split(' ')[1]?.replace(/,$/, '');
  if (r.kind === 'HI16') return `lui ${reg}, %hi(${r.symbol})`;
  const rt = ins.text.split(' ')[1]?.replace(/,$/, '');
  return `ori ${rt}, $at, %lo(${r.symbol})`;
}

export function compileFile(f: SourceFile): FileResult {
  const res: FileResult = { name: f.name, base: fileBase(f.name), tokens: null, unit: null, compiled: null, asmText: '', error: null, obj: null };
  try {
    res.tokens = tokenize(f.source);
    res.unit = parse(f.source);
    res.compiled = generate(res.unit, f.source, f.name);
    res.asmText = asmTextOf(res.compiled.asm);
    res.obj = buildObj(res);
  } catch (e) {
    if (e instanceof CompileError) res.error = { line: e.line, col: e.col, message: e.message };
    else throw e;
  }
  return res;
}

export function build(files: SourceFile[]): BuildResult {
  const results = files.map(compileFile);
  const bases = new Map<string, string>();
  for (const r of results) {
    const prev = bases.get(r.base);
    if (prev && !r.error) r.error = { line: 1, col: 1, message: `ファイル ${prev} と名前（拡張子を除く）が同じです。名前を変えてください` };
    bases.set(r.base, r.name);
  }
  if (results.some((r) => r.error || !r.compiled)) return { files: results, link: null };
  return { files: results, link: link(results) };
}

function link(files: FileResult[]): LinkResult {
  const errors: string[] = [];
  const definedIn = new Map<string, string>();
  for (const f of files) {
    for (const n of [...f.compiled!.defined, ...f.compiled!.globals]) {
      const prev = definedIn.get(n);
      if (prev) errors.push(`${n} が ${prev} と ${f.name} の両方にあります（同じ名前の関数・変数は1つだけ）`);
      else definedIn.set(n, f.name);
    }
  }
  for (const f of files) {
    for (const n of f.compiled!.called) {
      if (!definedIn.has(n)) errors.push(`${f.name} が呼んでいる関数 ${n} の中身が、どのファイルにもありません（undefined reference to \`${n}'）`);
    }
  }
  if (!definedIn.has('main')) errors.push('main 関数がどのファイルにもありません（プログラムは main から始まります）');
  else if (files.filter((f) => f.compiled!.defined.includes('main')).length > 1) errors.push('main 関数が2つ以上あります');

  // つないだアセンブリ
  const lines: string[] = [];
  const lineFile: number[] = [];
  const lineC: (number | undefined)[] = [];
  files.forEach((f, i) => {
    const head = `# ======== ${f.base}.s（${f.name} から） ========`;
    lines.push(head);
    lineFile.push(i);
    lineC.push(undefined);
    for (const l of f.compiled!.asm) {
      lines.push(l.text);
      lineFile.push(i);
      lineC.push(l.cLine);
    }
    lines.push('');
    lineFile.push(i);
    lineC.push(undefined);
  });
  const source = lines.join('\n');
  const empty: LinkResult = { ok: false, errors, layout: [], symbols: [], patches: [], program: null, source, lineFile, lineC };
  if (errors.length) return empty;
  const prog = assemble(source);
  if (prog.errors.length) {
    empty.errors = prog.errors.map((e) => `アセンブラのエラー：${e.message}`);
    return empty;
  }
  // 置き場所
  const layout: LayoutEntry[] = [];
  let textCursor = TEXT_BASE;
  let dataCursor = DATA_BASE;
  files.forEach((f, i) => {
    const ins = prog.text.filter((x) => lineFile[x.line - 1] === i);
    const textStart = ins.length ? ins[0].addr : textCursor;
    const textSize = ins.length * 4;
    const dl = prog.dataLabels.filter((d) => lineFile[d.line - 1] === i);
    const dataStart = dl.length ? Math.min(...dl.map((d) => d.addr)) : dataCursor;
    const dataEnd = dl.length ? Math.max(...dl.map((d) => d.addr + d.size)) : dataStart;
    layout.push({ file: f.name, textStart, textSize, dataStart, dataSize: dataEnd - dataStart });
    textCursor = textStart + textSize;
    dataCursor = dataEnd;
  });
  // 記号表（ほかのファイルから見える名前）
  const symbols: LinkResult['symbols'] = [];
  files.forEach((f) => {
    for (const n of [...f.compiled!.defined, ...f.compiled!.globals]) {
      const addr = prog.labels.get(n);
      if (addr === undefined) continue;
      symbols.push({ name: n, addr, file: f.name, section: addr >= DATA_BASE ? '.data' : '.text', kind: f.compiled!.defined.includes(n) ? '関数' : '変数' });
    }
  });
  symbols.sort((a, b) => a.addr - b.addr);
  // 番地を埋めたところ
  const byAddr = new Map(prog.text.map((x) => [x.addr, x]));
  const patches: Patch[] = [];
  files.forEach((f, i) => {
    const obj = f.obj;
    if (!obj) return;
    for (const oi of obj.text) {
      if (!oi.reloc) continue;
      const addr = layout[i].textStart + oi.off;
      const fin = byAddr.get(addr);
      if (!fin) continue;
      patches.push({ file: f.name, addr, off: oi.off, text: oi.text, before: oi.word, after: fin.word, reloc: oi.reloc });
    }
  });
  return { ok: true, errors: [], layout, symbols, patches, program: prog, source, lineFile, lineC };
}

// 実行した命令の説明（日本語）と、C 言語風の読み下し
import type { Instr, Program } from './assembler';
import { REG_NAMES, hex, s32 } from './defs';
import type { ExecInfo } from './machine';

const R = (i: number) => '$' + REG_NAMES[i];
const dec = (v: number) => String(s32(v));

/** 番地に名前を付ける（array[2]・msg[1]・スタック など） */
export function nameAddr(prog: Program, addr: number, sp?: number): string {
  for (const d of prog.dataLabels) {
    if (addr >= d.addr && addr < d.addr + Math.max(d.size, 1)) {
      const off = addr - d.addr;
      const unit = d.kind === 'word' ? 4 : d.kind === 'half' ? 2 : 1;
      if (d.count <= 1 && d.kind !== 'asciiz' && d.kind !== 'ascii' && d.kind !== 'space') return d.name;
      return off % unit === 0 ? `${d.name}[${off / unit}]` : `${d.name}+${off}`;
    }
  }
  if (sp !== undefined && addr >= 0x7f000000) return `スタック（$sp+${addr - sp}）`;
  for (const [a, names] of prog.textLabels) if (a === addr) return names[0];
  return '';
}

const withName = (prog: Program, addr: number, sp?: number) => {
  const n = nameAddr(prog, addr, sp);
  return n ? `${hex(addr)}（${n}）` : hex(addr);
};

export interface Explanation {
  /** 1行の要約 */
  summary: string;
  /** 計算の内訳など */
  details: string[];
}

/** 本当の命令1つの説明 */
export function explain(info: ExecInfo, prog: Program, spBefore?: number): Explanation {
  const ins = info.instr;
  const d: string[] = [];
  const w = info.writes[0];
  const rv = (reg: number) => info.reads.find((x) => x.reg === reg)?.value ?? 0;
  const val = (reg: number) => (reg === 0 ? 0 : rv(reg));
  const { rs, rt, imm } = ins;
  const op = ins.op;
  const sym: Record<string, string> = { add: '+', addu: '+', sub: '-', subu: '-', and: 'AND', or: 'OR', xor: 'XOR', nor: 'NOR', addi: '+', addiu: '+', andi: 'AND', ori: 'OR', xori: 'XOR' };

  if (['add', 'addu', 'sub', 'subu', 'and', 'or', 'xor', 'nor'].includes(op)) {
    const a = val(rs), b = val(rt);
    const logic = ['and', 'or', 'xor', 'nor'].includes(op);
    const summary = `${R(ins.rd)} ← ${R(rs)} ${sym[op]} ${R(rt)} ＝ ${logic ? hex(a) : dec(a)} ${sym[op]} ${logic ? hex(b) : dec(b)} ＝ ${logic ? hex(w?.value ?? 0) : dec(w?.value ?? 0)}`;
    if (logic) d.push('ビットごとに計算する（2進数の表示にすると分かりやすい）');
    if (ins.rd === 0) d.push('$zero には書けないので、結果は捨てられる');
    return { summary, details: d };
  }
  if (['addi', 'addiu', 'andi', 'ori', 'xori'].includes(op)) {
    const a = val(rs);
    const logic = !op.startsWith('add');
    if (rt === 29 && rs === 29 && op.startsWith('addi')) {
      const words = Math.abs(imm) / 4;
      const summary = `$sp ← $sp ${imm < 0 ? '−' : '+'} ${Math.abs(imm)} ＝ ${hex(w.value)}`;
      d.push(imm < 0
        ? `スタックに ${Math.abs(imm)} バイト（${words} ワード）の場所をとる。スタックは番地の小さい方へ伸びるので、$sp を減らす`
        : `スタックの ${imm} バイト（${words} ワード）の場所を返す。$sp を増やして元に戻す`);
      return { summary, details: d };
    }
    if (ins.pseudo === 'li' || ins.pseudo === 'la') {
      // li・la の展開の一部
      return { summary: `${R(rt)} ← ${rs === 0 ? '' : R(rs) + ' ' + sym[op] + ' '}${logic ? hex(imm, 4) : imm} ＝ ${logic ? hex(w.value) : dec(w.value)}`, details: [] };
    }
    return {
      summary: `${R(rt)} ← ${R(rs)} ${sym[op]} ${logic ? hex(imm, 4) : imm} ＝ ${logic ? hex(a) : dec(a)} ${sym[op]} ${logic ? hex(imm, 4) : imm} ＝ ${logic ? hex(w.value) : dec(w.value)}`,
      details: op === 'andi' || op === 'ori' || op === 'xori' ? ['定数は上の16ビットを 0 にして（ゼロ拡張）32ビットにする'] : [],
    };
  }
  if (op === 'lui') {
    return { summary: `${R(rt)} ← ${hex(imm, 4)} を上の16ビットに置く ＝ ${hex(w.value)}`, details: ['下の16ビットは 0 になる'] };
  }
  if (op === 'slt' || op === 'sltu' || op === 'slti' || op === 'sltiu') {
    const a = val(rs);
    const b = op === 'slt' || op === 'sltu' ? val(rt) : imm;
    const uns = op.endsWith('u');
    const fa = uns ? String(a >>> 0) : dec(a);
    const fb = uns ? String(b >>> 0) : dec(b);
    const res = w ? w.value : info.alu?.result ?? 0;
    const dst = op.startsWith('slti') ? R(rt) : R(ins.rd);
    return {
      summary: `${uns ? '符号なし' : '符号あり'}で比べる：${fa} < ${fb} は${res ? '正しい' : '正しくない'} → ${dst} ＝ ${res}`,
      details: [uns ? 'sltu は、いちばん上のビットも数の一部として比べる' : 'slt は、いちばん上のビットが 1 なら負の数として比べる'],
    };
  }
  if (op === 'sll' || op === 'srl' || op === 'sra') {
    const a = val(rt);
    const k = ins.shamt;
    if (op === 'sll' && ins.rd === 0 && rt === 0 && k === 0) return { summary: 'nop：何もしない', details: [] };
    const desc = op === 'sll' ? `左に ${k} ビットずらす（× ${2 ** k}）` : `右に ${k} ビットずらす（÷ ${2 ** k}${op === 'sra' ? '・符号を保つ' : ''}）`;
    return { summary: `${R(ins.rd)} ← ${R(rt)} を${desc} ＝ ${dec(a)} → ${dec(w?.value ?? 0)}`, details: [] };
  }
  if (op === 'sllv' || op === 'srlv' || op === 'srav') {
    return { summary: `${R(ins.rd)} ← ${R(rt)} を ${R(rs)}（${val(rs) & 31}）ビットずらす ＝ ${dec(w?.value ?? 0)}`, details: [] };
  }
  if (op === 'mult' || op === 'multu' || op === 'div' || op === 'divu') {
    const a = val(rs), b = val(rt);
    if (op.startsWith('mult')) {
      return { summary: `${R(rs)} × ${R(rt)} ＝ ${dec(a)} × ${dec(b)}。結果の上の32ビットを HI、下の32ビットを LO に入れる`, details: [`HI ＝ ${hex(info.hiLo!.hi)}、LO ＝ ${hex(info.hiLo!.lo)}`] };
    }
    return { summary: `${R(rs)} ÷ ${R(rt)} ＝ ${dec(a)} ÷ ${dec(b)}。商を LO、あまりを HI に入れる`, details: [`LO（商）＝ ${dec(info.hiLo!.lo)}、HI（あまり）＝ ${dec(info.hiLo!.hi)}`] };
  }
  if (op === 'mul') {
    return { summary: `${R(ins.rd)} ← ${R(rs)} × ${R(rt)} ＝ ${dec(val(rs))} × ${dec(val(rt))} ＝ ${dec(w?.value ?? 0)}`, details: [] };
  }
  if (op === 'mfhi' || op === 'mflo') {
    return { summary: `${R(ins.rd)} ← ${op === 'mfhi' ? 'HI' : 'LO'} ＝ ${dec(w?.value ?? 0)}`, details: [] };
  }
  if (info.mem) {
    const m = info.mem;
    const unit = m.size === 4 ? '4 バイト（1ワード）' : m.size === 2 ? '2 バイト' : '1 バイト';
    d.push(`番地 ＝ ${R(m.base)} ＋ ${m.offset} ＝ ${hex(m.baseValue)} ＋ ${m.offset} ＝ ${withName(prog, m.addr, spBefore)}`);
    if (m.write) {
      return { summary: `${R(rt)} の値 ${dec(m.value)} を、番地 ${withName(prog, m.addr, spBefore)} から ${unit} 書く`, details: d };
    }
    if (op === 'lb' || op === 'lh') d.push('符号つきで 32 ビットに広げる（いちばん上のビットをくり返す）');
    if (op === 'lbu' || op === 'lhu') d.push('上のビットを 0 にして 32 ビットに広げる');
    if (m.size === 1 && m.value >= 32 && m.value < 127) d.push(`読んだバイト ${m.value} は文字 '${String.fromCharCode(m.value)}'`);
    if (m.size === 1 && m.value === 0) d.push('読んだバイトは 0（文字列の終わりの印）');
    return { summary: `番地 ${withName(prog, m.addr, spBefore)} から ${unit} 読んで ${R(rt)} に入れる ＝ ${dec(w?.value ?? m.value)}`, details: d };
  }
  if (info.branch) {
    const b = info.branch;
    const eq = b.a === b.b;
    const target = nameAddr(prog, b.target);
    const cmp = `${R(rs)} ＝ ${dec(b.a)}、${R(rt)} ＝ ${dec(b.b)} → ${eq ? '等しい' : '等しくない'}`;
    const res = b.taken ? `飛ぶ（${target || hex(b.target)} へ）` : '飛ばない（次の命令へ）';
    d.push(`飛び先 ＝ (PC＋4) ＋ 定数×4 ＝ ${hex(b.pc4)} ＋ ${b.offset}×4 ＝ ${hex(b.target)}${target ? `（${target}）` : ''}`);
    d.push(op === 'beq' ? 'beq は「等しいとき」に飛ぶ' : 'bne は「等しくないとき」に飛ぶ');
    return { summary: `${cmp} → ${res}`, details: d };
  }
  if (info.jump) {
    const j = info.jump;
    const tname = nameAddr(prog, j.target);
    if (op === 'j') return { summary: `${tname || hex(j.target)}（${hex(j.target)}）へ飛ぶ`, details: [`飛び先 ＝ 命令の下26ビット × 4 ＝ ${hex(j.target)}`] };
    if (op === 'jal') {
      return {
        summary: `$ra ← ${hex(j.link!)}（jal の次の命令の番地 ＝ 戻り先）、${tname || hex(j.target)} へ飛ぶ`,
        details: ['関数から戻るときは jr $ra で、この番地に戻る'],
      };
    }
    return {
      summary: `${R(j.viaReg!)} に入っている番地 ${hex(j.target)} へ飛ぶ${j.viaReg === 31 ? '（呼び出し元の jal の次へ戻る）' : ''}`,
      details: [],
    };
  }
  if (info.syscall) {
    const s = info.syscall;
    const a0 = val(4);
    switch (s.code) {
      case 1: return { summary: `syscall 1 番（print_int）：$a0 の値 ${dec(a0)} を表示する`, details: [] };
      case 4: return { summary: `syscall 4 番（print_string）：番地 ${withName(prog, a0)} から、0 が出てくるまでの文字を表示する`, details: [`表示：「${s.output ?? ''}」`] };
      case 11: return { summary: `syscall 11 番（print_char）：$a0 の値 ${a0} を文字 '${s.output === '\n' ? '\\n' : s.output}' として表示する`, details: [] };
      case 10: return { summary: 'syscall 10 番（exit）：プログラムを終える', details: [] };
      case 5: return { summary: `syscall 5 番（read_int）：入力した整数 ${s.input} を $v0 に入れる`, details: [] };
      case 12: return { summary: `syscall 12 番（read_char）：入力した文字を $v0 に入れる`, details: [] };
      case 8: return { summary: `syscall 8 番（read_string）：入力した文字列を番地 ${withName(prog, a0)} に書く`, details: [] };
    }
    return { summary: `syscall ${s.code} 番`, details: [] };
  }
  return { summary: ins.text, details: [] };
}

/** ソースの1行（疑似命令はまとめて）の説明。infos はその行で実行した本当の命令の情報 */
export function explainLine(infos: ExecInfo[], prog: Program, spBefore?: number): Explanation {
  const first = infos[0];
  const last = infos[infos.length - 1];
  const ins = first.instr;
  if (!ins.pseudo || ins.parts === 1 && !['li', 'la', 'move', 'nop', 'b', 'beqz', 'bnez', 'not', 'neg'].includes(ins.pseudo)) {
    return explain(last, prog, spBefore);
  }
  const args = splitSourceArgs(ins.source);
  const wLast = last.writes.at(-1);
  switch (ins.pseudo) {
    case 'li': return { summary: `${args[0]} ← ${args[1]}`, details: ins.parts > 1 ? ['16ビットに入らない数なので、lui と ori の2命令で入れる'] : [] };
    case 'la': return { summary: `${args[0]} ← ${args[1]} の番地 ${withName(prog, wLast!.value)}`, details: ['la は「値」ではなく「番地」を入れる'] };
    case 'move': return { summary: `${args[0]} ← ${args[1]} ＝ ${dec(wLast?.value ?? 0)}`, details: [] };
    case 'nop': return { summary: 'nop：何もしない', details: [] };
    case 'not': return { summary: `${args[0]} ← ${args[1]} のビットを全部反対にする ＝ ${hex(wLast?.value ?? 0)}`, details: [] };
    case 'neg': return { summary: `${args[0]} ← −${args[1]} ＝ ${dec(wLast?.value ?? 0)}`, details: [] };
  }
  if (['blt', 'bgt', 'ble', 'bge', 'bltu', 'bgtu', 'bleu', 'bgeu'].includes(ins.pseudo)) {
    const b = last.branch!;
    const base = ins.pseudo.replace(/u$/, '');
    const symb = { blt: '<', bgt: '>', ble: '≤', bge: '≥' }[base]!;
    const target = nameAddr(prog, b.target);
    return {
      summary: `${args[0]} ${symb} ${args[1]} は${b.taken ? '正しい → 飛ぶ（' + (target || hex(b.target)) + ' へ）' : '正しくない → 飛ばない（次の命令へ）'}`,
      details: [`${ins.pseudo} は疑似命令。slt で比べて（$at に 0 か 1）、beq か bne で飛ぶ`],
    };
  }
  if (last.branch) return explain(last, prog, spBefore);
  if (last.mem) {
    const e = explain(last, prog, spBefore);
    e.details = [`ラベルの番地を lui で $at に作ってから読み書きする（${ins.parts} 命令）`, ...e.details.slice(1)];
    return e;
  }
  return explain(last, prog, spBefore);
}

export function splitSourceArgs(source: string): string[] {
  const m = /^\S+\s*(.*)$/.exec(source.trim());
  if (!m || !m[1]) return [];
  return m[1].split(',').map((s) => s.trim());
}

/** C 言語風の読み下し（ソースの書き方から） */
export function readable(ins: Instr): string {
  const op = (ins.pseudo ?? ins.op).toLowerCase();
  const srcOp = /^\S+/.exec(ins.source)?.[0].toLowerCase() ?? op;
  const a = splitSourceArgs(ins.source);
  const mem = (x: string) => {
    const m = /^(.*)\((\$\w+)\)$/.exec(x.replace(/\s/g, ''));
    if (m) return `メモリ[${m[2]}${m[1] && m[1] !== '0' ? (m[1].startsWith('-') ? ' − ' + m[1].slice(1) : ' + ' + m[1]) : ''}]`;
    return x;
  };
  const bin: Record<string, string> = { add: '+', addu: '+', addi: '+', addiu: '+', sub: '-', subu: '-', and: '&', andi: '&', or: '|', ori: '|', xor: '^', xori: '^', mul: '×' };
  switch (srcOp) {
    case 'li': return `${a[0]} = ${a[1]}`;
    case 'la': return `${a[0]} = ${a[1]} の番地`;
    case 'move': return `${a[0]} = ${a[1]}`;
    case 'nop': return '何もしない';
    case 'nor': return a[2] === '$zero' ? `${a[0]} = ~${a[1]}` : `${a[0]} = ~(${a[1]} | ${a[2]})`;
    case 'not': return `${a[0]} = ~${a[1]}`;
    case 'neg': return `${a[0]} = −${a[1]}`;
    case 'sll': return `${a[0]} = ${a[1]} << ${a[2]}（× ${2 ** Number(a[2] || 0)}）`;
    case 'srl': case 'sra': return `${a[0]} = ${a[1]} >> ${a[2]}（÷ ${2 ** Number(a[2] || 0)}）`;
    case 'slt': case 'slti': case 'sltu': case 'sltiu': return `${a[0]} = (${a[1]} < ${a[2]}) ? 1 : 0${srcOp.endsWith('u') ? '（符号なし）' : ''}`;
    case 'lui': return `${a[0]} = ${a[1]} << 16`;
    case 'lw': case 'lh': case 'lhu': case 'lb': case 'lbu': return `${a[0]} = ${mem(a[1])}`;
    case 'sw': case 'sh': case 'sb': return `${mem(a[1])} = ${a[0]}`;
    case 'beq': return `if (${a[0]} == ${a[1]}) goto ${a[2]}`;
    case 'bne': return `if (${a[0]} != ${a[1]}) goto ${a[2]}`;
    case 'blt': case 'bltu': return `if (${a[0]} < ${a[1]}) goto ${a[2]}`;
    case 'bgt': case 'bgtu': return `if (${a[0]} > ${a[1]}) goto ${a[2]}`;
    case 'ble': case 'bleu': return `if (${a[0]} <= ${a[1]}) goto ${a[2]}`;
    case 'bge': case 'bgeu': return `if (${a[0]} >= ${a[1]}) goto ${a[2]}`;
    case 'beqz': return `if (${a[0]} == 0) goto ${a[1]}`;
    case 'bnez': return `if (${a[0]} != 0) goto ${a[1]}`;
    case 'b': case 'j': return `goto ${a[0]}`;
    case 'jal': return `${a[0]}() を呼ぶ（$ra = 戻り先）`;
    case 'jr': return a[0] === '$ra' ? 'return（呼び出し元へ戻る）' : `goto ${a[0]} の番地`;
    case 'mult': case 'multu': return `HI, LO = ${a[0]} × ${a[1]}`;
    case 'div': case 'divu': return a.length === 3 ? `${a[0]} = ${a[1]} / ${a[2]}` : `LO = ${a[0]} / ${a[1]}、HI = ${a[0]} % ${a[1]}`;
    case 'rem': return `${a[0]} = ${a[1]} % ${a[2]}`;
    case 'mfhi': return `${a[0]} = HI`;
    case 'mflo': return `${a[0]} = LO`;
    case 'syscall': return 'OS に仕事を頼む（$v0 の番号）';
  }
  if (bin[srcOp] && a.length === 3) return `${a[0]} = ${a[1]} ${bin[srcOp]} ${a[2]}`;
  return ins.source;
}

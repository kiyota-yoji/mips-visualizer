// アセンブラ：ソース → 命令の列（疑似命令は本当の命令に展開する）＋データセグメント
import { DATA_BASE, OPS, PSEUDO_OPS, REG_INDEX, REG_NAMES, TEXT_BASE, s16, u32 } from './defs';

export interface Instr {
  addr: number;
  op: string; // 本当の命令の名前
  rs: number;
  rt: number;
  rd: number;
  shamt: number;
  imm: number; // I 形式の 16 ビット（符号ありの値として持つ。andi/ori/xori/lui は 0..65535）
  target: number; // J 形式・分岐の飛び先の番地
  targetLabel?: string;
  word: number; // 機械語
  line: number; // ソースの行（1 から）
  source: string; // ソースの命令（コメントを除く）
  pseudo?: string; // 疑似命令から展開したときの元の命令名
  part: number; // 展開したときの何番目か（0 から）
  parts: number; // 展開した命令の数
  text: string; // 展開後の命令の書き方（例 "addiu $t0, $zero, 10"）
}

export type DataKind = 'word' | 'half' | 'byte' | 'ascii' | 'asciiz' | 'space';

export interface DataLabel {
  name: string;
  addr: number;
  kind: DataKind;
  size: number; // バイト数
  count: number; // 要素の数（文字列は文字の数）
  line: number;
}

export interface AsmError {
  line: number;
  message: string;
}

export interface Program {
  text: Instr[];
  data: Uint8Array;
  labels: Map<string, number>;
  dataLabels: DataLabel[];
  textLabels: Map<number, string[]>; // 番地 → ラベル
  entry: number;
  errors: AsmError[];
}

// ------------------------------------------------------------
// 字句

class AsmFail extends Error {}
const fail = (msg: string): never => {
  throw new AsmFail(msg);
};

function stripComment(line: string): string {
  let inStr = false;
  let inChr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && (inStr || inChr)) {
      i++;
      continue;
    }
    if (c === '"' && !inChr) inStr = !inStr;
    else if (c === "'" && !inStr) inChr = !inChr;
    else if (c === '#' && !inStr && !inChr) return line.slice(0, i);
  }
  return line;
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inStr = false;
  let inChr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && (inStr || inChr)) {
      cur += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"' && !inChr) inStr = !inStr;
    if (c === "'" && !inStr) inChr = !inChr;
    if (c === ',' && !inStr && !inChr) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim() !== '' || out.length) out.push(cur.trim());
  return out;
}

const ESC: Record<string, number> = { n: 10, t: 9, r: 13, '0': 0, '\\': 92, '"': 34, "'": 39, a: 7, b: 8, f: 12, v: 11 };

function unescape(body: string): number[] {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      const n = body[++i];
      if (n === undefined) fail('文字列の最後の \\ のあとに文字がありません');
      if (n in ESC) bytes.push(ESC[n]);
      else if (n === 'x') {
        const h = body.slice(i + 1, i + 3);
        bytes.push(parseInt(h, 16));
        i += 2;
      } else fail(`\\${n} という書き方は使えません（\\n・\\t・\\0・\\\\・\\" が使えます）`);
    } else {
      bytes.push(...enc.encode(c));
    }
  }
  return bytes;
}

export function parseImm(tok: string): number {
  const t = tok.trim();
  const ch = /^'(\\?.)'$/.exec(t);
  if (ch) return ch[1].length === 2 ? unescape(ch[1])[0] : ch[1].charCodeAt(0);
  if (/^[+-]?(0x[0-9a-f]+|0b[01]+|\d+)$/i.test(t)) {
    const neg = t.startsWith('-');
    const body = t.replace(/^[+-]/, '');
    const v = body.toLowerCase().startsWith('0b') ? parseInt(body.slice(2), 2) : Number(body);
    if (!Number.isFinite(v)) fail(`数 ${t} が読めません`);
    return neg ? -v : v;
  }
  return fail(`「${t}」は数ではありません`);
}

const isImm = (t: string): boolean => {
  try {
    parseImm(t);
    return true;
  } catch {
    return false;
  }
};

function parseReg(tok: string): number {
  const t = tok.trim();
  if (!t.startsWith('$')) {
    if (Object.hasOwn(REG_INDEX, t)) fail(`レジスタには $ を付けます（${t} → $${t}）`);
    fail(`「${t}」はレジスタではありません（$t0 のように書きます）`);
  }
  const name = t.slice(1);
  if (/^\d+$/.test(name)) {
    const n = Number(name);
    if (n < 32) return n;
  } else if (Object.hasOwn(REG_INDEX, name)) return REG_INDEX[name];
  return fail(`${t} というレジスタはありません`);
}

const LABEL_RE = /^[A-Za-z_.][\w.]*$/;

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function suggestOp(op: string): string {
  const all = [...Object.keys(OPS), ...PSEUDO_OPS];
  let best = '';
  let bd = 99;
  for (const c of all) {
    const dd = editDistance(op, c);
    if (dd < bd) {
      bd = dd;
      best = c;
    }
  }
  return bd <= 2 ? `。${best} ですか？` : '';
}

// ------------------------------------------------------------
// 展開：ソースの1命令 → 本当の命令（オペランドは文字列のまま）

interface Real {
  op: string;
  args: string[];
}

const fitsS16 = (v: number) => v >= -32768 && v <= 32767;
const fitsU16 = (v: number) => v >= 0 && v <= 0xffff;

const R_TO_I: Record<string, string> = {
  add: 'addi', addu: 'addiu', and: 'andi', or: 'ori', xor: 'xori', slt: 'slti', sltu: 'sltiu',
};

function liExpand(rd: string, v: number): Real[] {
  if (v < -0x80000000 || v > 0xffffffff) fail(`数 ${v} は 32 ビットに入りません`);
  if (fitsS16(v)) return [{ op: 'addiu', args: [rd, '$zero', String(v)] }];
  if (fitsU16(v)) return [{ op: 'ori', args: [rd, '$zero', String(v)] }];
  const w = u32(v);
  return [
    { op: 'lui', args: ['$at', String(w >>> 16)] },
    { op: 'ori', args: [rd, '$at', String(w & 0xffff)] },
  ];
}

/** 番地のオペランドがラベルなどで、展開が必要か */
function memNeedsExpand(arg: string): boolean {
  return !/^\s*([+-]?(0x[0-9a-f]+|\d+))?\s*\(\s*\$\w+\s*\)\s*$/i.test(arg);
}

function expand(op: string, a: string[], labelAddr: (l: string) => number | undefined): Real[] {
  const need = (n: number) => {
    if (a.length !== n) fail(`${op} のオペランドは ${n} 個です（いまは ${a.length} 個）`);
  };
  switch (op) {
    case 'nop':
      need(0);
      return [{ op: 'sll', args: ['$zero', '$zero', '0'] }];
    case 'li':
      need(2);
      return liExpand(a[0], parseImm(a[1]));
    case 'la': {
      need(2);
      const addr = labelAddr(a[1].trim()) ?? DATA_BASE;
      return [
        { op: 'lui', args: ['$at', String(addr >>> 16)] },
        { op: 'ori', args: [a[0], '$at', String(addr & 0xffff)] },
      ];
    }
    case 'move':
      need(2);
      return [{ op: 'addu', args: [a[0], '$zero', a[1]] }];
    case 'not':
      need(2);
      return [{ op: 'nor', args: [a[0], a[1], '$zero'] }];
    case 'neg':
    case 'negu':
      need(2);
      return [{ op: op === 'neg' ? 'sub' : 'subu', args: [a[0], '$zero', a[1]] }];
    case 'b':
      need(1);
      return [{ op: 'beq', args: ['$zero', '$zero', a[0]] }];
    case 'beqz':
    case 'bnez':
      need(2);
      return [{ op: op === 'beqz' ? 'beq' : 'bne', args: [a[0], '$zero', a[1]] }];
    case 'blt': case 'bge': case 'bgt': case 'ble':
    case 'bltu': case 'bgeu': case 'bgtu': case 'bleu': {
      need(3);
      const uns = op.endsWith('u');
      const base = uns ? op.slice(0, -1) : op;
      const slt = uns ? 'sltu' : 'slt';
      const br = base === 'blt' || base === 'bgt' ? 'bne' : 'beq';
      const pre: Real[] = [];
      let s = a[0];
      let t = a[1];
      if (isImm(t)) {
        const v = parseImm(t);
        if ((base === 'blt' || base === 'bge') && fitsS16(v)) {
          return [
            { op: uns ? 'sltiu' : 'slti', args: ['$at', s, String(v)] },
            { op: br, args: ['$at', '$zero', a[2]] },
          ];
        }
        pre.push(...liExpand('$at', v));
        t = '$at';
      }
      // blt/bge: s < t を調べる。bgt/ble: t < s を調べる
      if (base === 'bgt' || base === 'ble') [s, t] = [t, s];
      return [...pre, { op: slt, args: ['$at', s, t] }, { op: br, args: ['$at', '$zero', a[2]] }];
    }
    case 'rem':
    case 'remu':
      need(3);
      return [
        { op: op === 'rem' ? 'div' : 'divu', args: [a[1], a[2]] },
        { op: 'mfhi', args: [a[0]] },
      ];
  }
  // ここからは本当の命令（必要なら展開する）
  const def = OPS[op];
  if ((op === 'div' || op === 'divu') && a.length === 3) {
    const pre: Real[] = [];
    let t = a[2];
    if (isImm(t)) {
      pre.push(...liExpand('$at', parseImm(t)));
      t = '$at';
    }
    return [...pre, { op, args: [a[1], t] }, { op: 'mflo', args: [a[0]] }];
  }
  if (def.syntax === 'd,s,t' && a.length === 3 && isImm(a[2])) {
    // add $t0, $t1, 5 のように即値を書いたとき
    const v = parseImm(a[2]);
    if (op === 'sub' || op === 'subu') {
      if (fitsS16(-v)) return [{ op: op === 'sub' ? 'addi' : 'addiu', args: [a[0], a[1], String(-v)] }];
    } else if (R_TO_I[op]) {
      const iop = R_TO_I[op];
      const ok = OPS[iop].syntax.endsWith('u') ? fitsU16(v) : fitsS16(v);
      if (ok) return [{ op: iop, args: [a[0], a[1], String(v)] }];
    }
    return [...liExpand('$at', v), { op, args: [a[0], a[1], '$at'] }];
  }
  if (def.format === 'I' && /i|u$/.test(def.syntax) && def.syntax !== 't,u' && a.length === 3 && isImm(a[2])) {
    // addi などで即値が 16 ビットに入らないとき
    const v = parseImm(a[2]);
    const ok = def.syntax.endsWith('u') ? fitsU16(v) : fitsS16(v);
    if (!ok) {
      const rop = Object.entries(R_TO_I).find(([, i]) => i === op)?.[0];
      if (rop) return [...liExpand('$at', v), { op: rop, args: [a[0], a[1], '$at'] }];
    }
  }
  if (def.format === 'I' && def.syntax === 's,t,l' && a.length === 3 && isImm(a[1])) {
    // beq $t0, 5, L
    return [...liExpand('$at', parseImm(a[1])), { op, args: [a[0], '$at', a[2]] }];
  }
  if (def.syntax === 't,m' && a.length === 2 && memNeedsExpand(a[1])) {
    // lw $t0, label / lw $t0, label+4 / lw $t0, label($t1)
    const m = /^\s*([A-Za-z_.][\w.]*)?\s*([+-]\s*(?:0x[0-9a-f]+|\d+))?\s*(?:\(\s*(\$\w+)\s*\))?\s*$/i.exec(a[1]);
    if (!m || (!m[1] && !m[2])) fail(`番地の書き方「${a[1]}」が読めません（0($t1) や ラベル のように書きます）`);
    let addr = 0;
    if (m![1]) {
      const la = labelAddr(m![1]);
      addr = la ?? DATA_BASE;
    }
    if (m![2]) addr += parseImm(m![2].replace(/\s/g, ''));
    addr = u32(addr);
    if (!m![1] && fitsS16(addr) && m![3]) return [{ op, args: [a[0], `${addr}(${m![3]})`] }];
    const hi = ((addr + 0x8000) >>> 16) & 0xffff;
    const lo = s16(addr);
    const pre: Real[] = [{ op: 'lui', args: ['$at', String(hi)] }];
    if (m![3]) pre.push({ op: 'addu', args: ['$at', '$at', m![3]] });
    return [...pre, { op, args: [a[0], `${lo}($at)`] }];
  }
  return [{ op, args: a }];
}

// ------------------------------------------------------------
// 機械語にする

function encode(op: string, args: string[], addr: number, labels: Map<string, number>, line: number): Omit<Instr, 'line' | 'source' | 'pseudo' | 'part' | 'parts'> {
  const def = OPS[op];
  const parts = def.syntax ? def.syntax.split(',') : [];
  if (args.length !== parts.length) {
    fail(`${op} のオペランドは ${parts.length} 個です（いまは ${args.length} 個）`);
  }
  let rs = 0, rt = 0, rd = 0, shamt = 0, imm = 0, target = 0;
  let targetLabel: string | undefined;
  parts.forEach((p, i) => {
    const t = args[i];
    switch (p) {
      case 'd': rd = parseReg(t); break;
      case 's': rs = parseReg(t); break;
      case 't': rt = parseReg(t); break;
      case 'h': {
        shamt = parseImm(t);
        if (shamt < 0 || shamt > 31) fail(`シフト量 ${shamt} は 0〜31 で書きます`);
        break;
      }
      case 'i': {
        imm = parseImm(t);
        if (!fitsS16(imm)) fail(`数 ${imm} は 16 ビット（-32768〜32767）に入りません`);
        break;
      }
      case 'u': {
        imm = parseImm(t);
        if (imm < 0 && imm >= -32768) imm &= 0xffff;
        if (!fitsU16(imm)) fail(`数 ${imm} は 16 ビット（0〜65535）に入りません`);
        break;
      }
      case 'm': {
        const m = /^\s*([+-]?(?:0x[0-9a-f]+|\d+))?\s*\(\s*(\$\w+)\s*\)\s*$/i.exec(t);
        if (!m) fail(`番地の書き方「${t}」が読めません`);
        imm = m![1] ? parseImm(m![1]) : 0;
        if (!fitsS16(imm)) fail(`番地のずれ ${imm} は 16 ビットに入りません`);
        rs = parseReg(m![2]);
        break;
      }
      case 'l':
      case 'a': {
        const name = t.trim();
        if (!LABEL_RE.test(name)) fail(`「${name}」はラベルではありません`);
        const ta = labels.get(name);
        if (ta === undefined) fail(`ラベル ${name} が見つかりません`);
        targetLabel = name;
        target = ta!;
        if (p === 'l') {
          const off = (target - (addr + 4)) / 4;
          if (!fitsS16(off)) fail(`飛び先 ${name} が遠すぎます`);
          imm = off;
        } else if (((addr + 4) & 0xf0000000) !== (target & 0xf0000000)) {
          fail(`飛び先 ${name} に j では届きません`);
        }
        break;
      }
    }
  });
  if (op === 'jalr') rd = 31;
  let word: number;
  if (def.format === 'R') {
    word = (def.opcode << 26) | (rs << 21) | (rt << 16) | (rd << 11) | (shamt << 6) | def.funct!;
  } else if (def.format === 'I') {
    word = (def.opcode << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff);
  } else {
    word = (def.opcode << 26) | ((target >>> 2) & 0x3ffffff);
  }
  void line;
  const text = formatInstr(op, rs, rt, rd, shamt, imm, targetLabel);
  return { addr, op, rs, rt, rd, shamt, imm, target, targetLabel, word: u32(word), text };
}

const rn = (i: number) => '$' + REG_NAMES[i];

export function formatInstr(op: string, rs: number, rt: number, rd: number, shamt: number, imm: number, label?: string): string {
  const def = OPS[op];
  if (op === 'syscall') return 'syscall';
  const parts = def.syntax.split(',');
  const out = parts.map((p) => {
    switch (p) {
      case 'd': return rn(rd);
      case 's': return rn(rs);
      case 't': return rn(rt);
      case 'h': return String(shamt);
      case 'i': case 'u': return String(imm);
      case 'm': return `${imm}(${rn(rs)})`;
      default: return label ?? '?';
    }
  });
  return `${op} ${out.join(', ')}`;
}

// ------------------------------------------------------------
// 全体

interface Stmt {
  line: number;
  source: string;
  op: string;
  args: string[];
  addr: number;
  size: number; // 本当の命令の数
}

export function assemble(src: string): Program {
  const errors: AsmError[] = [];
  const labels = new Map<string, number>();
  const textLabels = new Map<number, string[]>();
  const dataLabels: DataLabel[] = [];
  const data: number[] = [];
  const stmts: Stmt[] = [];
  const dataFixups: { offset: number; label: string; line: number }[] = [];
  let seg: 'text' | 'data' = 'text';
  let textAddr = TEXT_BASE;
  let pendingDataLabels: { name: string; line: number }[] = [];

  const lines = src.replace(/^﻿/, '').split(/\r?\n/);

  // 1回目：ラベルの番地と、データを決める（ラベルを使わない展開の大きさはここで決まる）
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    try {
      let line = stripComment(raw).trim();
      if (!line) return;
      for (;;) {
        const m = /^([A-Za-z_.][\w.]*)\s*:\s*(.*)$/.exec(line);
        if (!m) break;
        const name = m[1];
        line = m[2].trim();
        if (labels.has(name)) fail(`ラベル ${name} が2回出てきます`);
        if (seg === 'data') {
          let align = 1;
          if (line.startsWith('.word')) align = 4;
          else if (line.startsWith('.half')) align = 2;
          while (data.length % align) data.push(0);
          labels.set(name, DATA_BASE + data.length);
          pendingDataLabels.push({ name, line: lineNo });
        } else {
          labels.set(name, textAddr);
          const arr = textLabels.get(textAddr) ?? [];
          arr.push(name);
          textLabels.set(textAddr, arr);
        }
      }
      if (!line) return;
      if (line.startsWith('.')) {
        const m = /^(\.\w+)\s*(.*)$/.exec(line)!;
        const d = m[1].toLowerCase();
        const rest = m[2].trim();
        if (d === '.text' || d === '.data') {
          seg = d === '.text' ? 'text' : 'data';
          return;
        }
        if (d === '.globl' || d === '.global' || d === '.extern' || d === '.ent' || d === '.end') return;
        if (seg === 'text') fail(`${d} は .data のあとに書きます`);
        const start = data.length;
        let kind: DataKind = 'byte';
        let count = 0;
        const values = (s: string) => {
          const out: string[] = [];
          for (const v of splitArgs(s)) {
            const rep = /^(.+?)\s*:\s*(\d+)$/.exec(v);
            if (rep) for (let k = 0; k < Number(rep[2]); k++) out.push(rep[1]);
            else out.push(...v.split(/\s+/).filter(Boolean));
          }
          return out;
        };
        switch (d) {
          case '.word':
            kind = 'word';
            while (data.length % 4) data.push(0);
            for (const v of values(rest)) {
              let n = 0;
              if (isImm(v)) n = parseImm(v);
              else if (LABEL_RE.test(v)) dataFixups.push({ offset: data.length, label: v, line: lineNo });
              else fail(`.word の値「${v}」が読めません`);
              const w = u32(n);
              data.push(w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, w >>> 24);
              count++;
            }
            break;
          case '.half':
            kind = 'half';
            while (data.length % 2) data.push(0);
            for (const v of values(rest)) {
              const n = parseImm(v) & 0xffff;
              data.push(n & 0xff, n >>> 8);
              count++;
            }
            break;
          case '.byte':
            kind = 'byte';
            for (const v of values(rest)) {
              data.push(parseImm(v) & 0xff);
              count++;
            }
            break;
          case '.ascii':
          case '.asciiz': {
            kind = d === '.ascii' ? 'ascii' : 'asciiz';
            for (const s of splitArgs(rest)) {
              const sm = /^"(.*)"$/.exec(s);
              if (!sm) fail(`${d} の文字列は "..." で囲みます`);
              const bytes = unescape(sm![1]);
              data.push(...bytes);
              count += bytes.length;
              if (d === '.asciiz') data.push(0);
            }
            break;
          }
          case '.space': {
            kind = 'space';
            const n = parseImm(rest);
            for (let k = 0; k < n; k++) data.push(0);
            count = n;
            break;
          }
          case '.align': {
            const n = 1 << parseImm(rest);
            while (data.length % n) data.push(0);
            // .align のあとのラベルの番地を揃え直す
            for (const p of pendingDataLabels) {
              labels.set(p.name, DATA_BASE + data.length);
            }
            return;
          }
          default:
            fail(`${d} という指示子は使えません`);
        }
        for (const p of pendingDataLabels) {
          dataLabels.push({ name: p.name, addr: DATA_BASE + start, kind, size: data.length - start, count, line: p.line });
          labels.set(p.name, DATA_BASE + start);
        }
        pendingDataLabels = [];
        return;
      }
      if (seg === 'data') fail(`命令は .text のあとに書きます`);
      const m = /^(\S+)\s*(.*)$/.exec(line)!;
      const op = m[1].toLowerCase();
      const args = m[2].trim() === '' ? [] : splitArgs(m[2]);
      if (!Object.hasOwn(OPS, op) && !PSEUDO_OPS.has(op)) fail(`${op} という命令はありません${suggestOp(op)}`);
      // 大きさだけ決める（ラベルの番地は仮でよい：la・lw label はいつも同じ大きさ）
      const size = expand(op, args, () => DATA_BASE).length;
      stmts.push({ line: lineNo, source: line, op, args, addr: textAddr, size });
      textAddr += 4 * size;
    } catch (e) {
      if (e instanceof AsmFail) errors.push({ line: lineNo, message: `${lineNo}行目：${e.message}` });
      else throw e;
    }
  });
  for (const p of pendingDataLabels) {
    dataLabels.push({ name: p.name, addr: labels.get(p.name)!, kind: 'space', size: 0, count: 0, line: p.line });
  }
  for (const f of dataFixups) {
    const v = labels.get(f.label);
    if (v === undefined) {
      errors.push({ line: f.line, message: `${f.line}行目：ラベル ${f.label} が見つかりません` });
      continue;
    }
    data[f.offset] = v & 0xff;
    data[f.offset + 1] = (v >>> 8) & 0xff;
    data[f.offset + 2] = (v >>> 16) & 0xff;
    data[f.offset + 3] = v >>> 24;
  }

  // 2回目：展開して機械語にする
  const text: Instr[] = [];
  for (const st of stmts) {
    try {
      const reals = expand(st.op, st.args, (l) => labels.get(l));
      if (st.op === 'la') {
        const l = st.args[1]?.trim();
        if (!labels.has(l)) fail(`ラベル ${l} が見つかりません`);
      }
      reals.forEach((r, k) => {
        const addr = st.addr + 4 * k;
        const enc = encode(r.op, r.args, addr, labels, st.line);
        text.push({
          ...enc,
          line: st.line,
          source: st.source,
          pseudo: reals.length > 1 || r.op !== st.op ? st.op : undefined,
          part: k,
          parts: reals.length,
        });
      });
    } catch (e) {
      if (e instanceof AsmFail) errors.push({ line: st.line, message: `${st.line}行目：${e.message}` });
      else throw e;
    }
  }

  const main = labels.get('main');
  if (main === undefined && errors.length === 0 && text.length > 0) {
    errors.push({ line: 1, message: 'main というラベルがありません（プログラムは main: から始めます）' });
  }
  errors.sort((x, y) => x.line - y.line);
  return {
    text,
    data: Uint8Array.from(data),
    labels,
    dataLabels,
    textLabels,
    entry: main ?? TEXT_BASE,
    errors,
  };
}

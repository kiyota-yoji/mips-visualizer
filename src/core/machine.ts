// シミュレーター：1命令ずつ実行し、変わったところを記録する（戻る・アニメーションに使う）
import type { Instr, Program } from './assembler';
import { DATA_BASE, GP_INIT, REG_INDEX, REG_NAMES, STACK_TOP, TEXT_BASE, hex, s32, u32 } from './defs';

export interface RegAccess {
  reg: number;
  value: number;
}

export interface MemAccess {
  addr: number;
  size: number;
  value: number;
  write: boolean;
  base: number; // 番地の計算に使ったレジスタ
  baseValue: number;
  offset: number;
}

export interface BranchInfo {
  taken: boolean;
  a: number; // 比べた値（符号なし 32 ビット）
  b: number;
  pc4: number;
  offset: number;
  target: number;
}

export interface ExecInfo {
  instr: Instr;
  pc: number;
  nextPc: number;
  reads: RegAccess[];
  writes: { reg: number; old: number; value: number }[];
  hiLo?: { hi: number; lo: number };
  mem?: MemAccess;
  branch?: BranchInfo;
  jump?: { target: number; link?: number; viaReg?: number };
  alu?: { a: number; b: number; result: number; op: string };
  syscall?: { code: number; name: string; output?: string; input?: string };
  halted?: boolean;
}

interface Undo {
  pc: number;
  regs: [number, number, boolean][];
  hi: number;
  lo: number;
  hiLoInit: boolean;
  mem: [number, number | undefined, boolean][];
  outLen: number;
  input?: string;
  halted: boolean;
  steps: number;
  info: ExecInfo;
}

export class RuntimeError extends Error {
  constructor(public line: number, message: string) {
    super(message);
  }
}

export type StepStatus = 'ok' | 'halted' | 'input' | 'error';

export interface StepResult {
  status: StepStatus;
  info?: ExecInfo;
  error?: RuntimeError;
  inputKind?: 'int' | 'string' | 'char';
}

export interface MachineOptions {
  strictUninit: boolean;
  historyLimit: number;
}

const SYSCALL_NAME: Record<number, string> = {
  1: 'print_int', 4: 'print_string', 5: 'read_int', 8: 'read_string', 10: 'exit', 11: 'print_char', 12: 'read_char',
};

export class Machine {
  regs = new Uint32Array(32);
  init: boolean[] = Array(32).fill(false);
  hi = 0;
  lo = 0;
  hiLoInit = false;
  pc: number;
  mem = new Map<number, number>();
  /** 値の入っていないレジスタを sw で書いた番地（mipsy と同じく、退避と復元は許す） */
  memUninit = new Set<number>();
  output = '';
  halted = false;
  steps = 0;
  inputQueue: string[] = [];
  history: Undo[] = [];
  readonly byAddr = new Map<number, Instr>();
  private cur: Undo | null = null;
  opts: MachineOptions;

  constructor(public prog: Program, opts: Partial<MachineOptions> = {}) {
    this.opts = { strictUninit: true, historyLimit: 10000, ...opts };
    for (const ins of prog.text) this.byAddr.set(ins.addr, ins);
    prog.data.forEach((b, i) => this.mem.set(DATA_BASE + i, b));
    for (const n of ['zero', 'sp', 'gp', 'fp', 'ra']) this.init[REG_INDEX[n]] = true;
    this.regs[REG_INDEX.sp] = STACK_TOP;
    this.regs[REG_INDEX.gp] = GP_INIT;
    this.pc = prog.entry;
  }

  get textEnd(): number {
    return TEXT_BASE + 4 * this.prog.text.length;
  }

  currentInstr(): Instr | undefined {
    return this.byAddr.get(this.pc);
  }

  readByte(addr: number): number {
    return this.mem.get(u32(addr)) ?? 0;
  }

  readWord(addr: number): number {
    return u32(this.readByte(addr) | (this.readByte(addr + 1) << 8) | (this.readByte(addr + 2) << 16) | (this.readByte(addr + 3) << 24));
  }

  // ---- 実行中の読み書き（変化を記録する） ----

  private r(i: number, info: ExecInfo, allowUninit = false): number {
    if (!this.init[i] && this.opts.strictUninit && !allowUninit) {
      throw new RuntimeError(info.instr.line, `$${REG_NAMES[i]} にはまだ値が入っていません（値を入れてから使います）`);
    }
    const v = this.regs[i];
    if (i !== 0 && !info.reads.some((x) => x.reg === i)) info.reads.push({ reg: i, value: v });
    return v;
  }

  private w(i: number, v: number, info: ExecInfo, initialized = true): void {
    if (i === 0) return;
    this.cur!.regs.push([i, this.regs[i], this.init[i]]);
    info.writes.push({ reg: i, old: this.regs[i], value: u32(v) });
    this.regs[i] = u32(v);
    this.init[i] = initialized;
  }

  private checkAddr(addr: number, size: number, line: number, write: boolean): void {
    const what = write ? '書き込み' : '読み出し';
    if (addr % size !== 0) {
      throw new RuntimeError(line, `番地 ${hex(addr)} は ${size} の倍数ではないので、${size} バイトの${what}ができません`);
    }
    const inData = addr >= 0x10000000 && addr + size <= 0x10100000;
    const inStack = addr >= 0x7f000000 && addr + size <= 0x80000000;
    if (!inData && !inStack) {
      throw new RuntimeError(line, `番地 ${hex(addr)} は読み書きできません（データやスタックの番地ではありません）`);
    }
  }

  private load(addr: number, size: number, line: number): number {
    this.checkAddr(addr, size, line, false);
    let v = 0;
    for (let k = size - 1; k >= 0; k--) v = (v << 8) | this.readByte(addr + k);
    return u32(v);
  }

  private store(addr: number, size: number, v: number, line: number, initialized = true): void {
    this.checkAddr(addr, size, line, true);
    for (let k = 0; k < size; k++) {
      const a = u32(addr + k);
      this.cur!.mem.push([a, this.mem.get(a), this.memUninit.has(a)]);
      this.mem.set(a, (v >>> (8 * k)) & 0xff);
      if (initialized) this.memUninit.delete(a);
      else this.memUninit.add(a);
    }
  }

  private readCString(addr: number): string {
    const bytes: number[] = [];
    for (let a = addr; bytes.length < 100000; a++) {
      const b = this.readByte(a);
      if (b === 0) break;
      bytes.push(b);
    }
    return new TextDecoder().decode(Uint8Array.from(bytes));
  }

  // ---- 1命令 ----

  step(): StepResult {
    if (this.halted) return { status: 'halted' };
    const ins = this.byAddr.get(this.pc);
    if (!ins) {
      const line = this.prog.text.at(-1)?.line ?? 1;
      const msg = this.pc === this.textEnd
        ? 'プログラムの最後を越えました（最後は li $v0, 10 と syscall で終わります）'
        : `番地 ${hex(this.pc)} には命令がありません`;
      return { status: 'error', error: new RuntimeError(line, msg) };
    }
    // syscall の入力待ち
    if (ins.op === 'syscall' && this.inputQueue.length === 0 && this.init[2]) {
      const code = this.regs[2];
      if (code === 5 || code === 8 || code === 12) {
        return { status: 'input', inputKind: code === 5 ? 'int' : code === 8 ? 'string' : 'char' };
      }
    }
    const info: ExecInfo = { instr: ins, pc: this.pc, nextPc: this.pc + 4, reads: [], writes: [] };
    this.cur = {
      pc: this.pc, regs: [], hi: this.hi, lo: this.lo, hiLoInit: this.hiLoInit, mem: [],
      outLen: this.output.length, halted: this.halted, steps: this.steps, info,
    };
    try {
      this.exec(ins, info);
    } catch (e) {
      this.rollback(this.cur);
      this.cur = null;
      if (e instanceof RuntimeError) return { status: 'error', error: e, info };
      throw e;
    }
    this.pc = info.nextPc;
    this.steps++;
    this.history.push(this.cur);
    if (this.history.length > this.opts.historyLimit) this.history.shift();
    this.cur = null;
    return { status: this.halted ? 'halted' : 'ok', info };
  }

  private rollback(u: Undo): void {
    for (let k = u.regs.length - 1; k >= 0; k--) {
      const [i, v, ini] = u.regs[k];
      this.regs[i] = v;
      this.init[i] = ini;
    }
    for (let k = u.mem.length - 1; k >= 0; k--) {
      const [a, v, un] = u.mem[k];
      if (v === undefined) this.mem.delete(a);
      else this.mem.set(a, v);
      if (un) this.memUninit.add(a);
      else this.memUninit.delete(a);
    }
    this.hi = u.hi;
    this.lo = u.lo;
    this.hiLoInit = u.hiLoInit;
    this.output = this.output.slice(0, u.outLen);
    if (u.input !== undefined) this.inputQueue.unshift(u.input);
    this.halted = u.halted;
    this.pc = u.pc;
    this.steps = u.steps;
  }

  /** 1つ戻る。戻したときの ExecInfo を返す */
  back(): ExecInfo | undefined {
    const u = this.history.pop();
    if (!u) return undefined;
    this.rollback(u);
    return u.info;
  }

  get canBack(): boolean {
    return this.history.length > 0;
  }

  lastInfo(): ExecInfo | undefined {
    return this.history.at(-1)?.info;
  }

  private exec(ins: Instr, info: ExecInfo): void {
    const R = (i: number) => this.r(i, info);
    const W = (i: number, v: number) => this.w(i, v, info);
    const alu = (op: string, a: number, b: number, result: number) => {
      info.alu = { op, a: u32(a), b: u32(b), result: u32(result) };
      return result;
    };
    const ovf = (res: number, a: number, b: number, sym: string) => {
      if (res > 0x7fffffff || res < -0x80000000) {
        throw new RuntimeError(
          ins.line,
          `${ins.op} の結果 ${s32(a)} ${sym} ${s32(b)} = ${res} が 32 ビット（符号あり）に収まりません（あふれ）。${ins.op === 'sub' ? 'subu' : ins.op + 'u'} ならあふれても止まりません`,
        );
      }
    };
    const { rs, rt, rd, shamt, imm } = ins;
    const pc4 = info.pc + 4;
    switch (ins.op) {
      case 'add': case 'addi': {
        const a = s32(R(rs));
        const b = ins.op === 'add' ? s32(R(rt)) : imm;
        const res = a + b;
        ovf(res, a, b, '+');
        W(ins.op === 'add' ? rd : rt, alu('+', a, b, res));
        break;
      }
      case 'addu': case 'addiu': {
        const a = R(rs);
        const b = ins.op === 'addu' ? R(rt) : u32(imm);
        W(ins.op === 'addu' ? rd : rt, alu('+', a, b, a + b));
        break;
      }
      case 'sub': {
        const a = s32(R(rs));
        const b = s32(R(rt));
        const res = a - b;
        ovf(res, a, b, '-');
        W(rd, alu('-', a, b, res));
        break;
      }
      case 'subu': {
        const a = R(rs);
        const b = R(rt);
        W(rd, alu('-', a, b, a - b));
        break;
      }
      case 'and': { const a = R(rs), b = R(rt); W(rd, alu('AND', a, b, a & b)); break; }
      case 'or': { const a = R(rs), b = R(rt); W(rd, alu('OR', a, b, a | b)); break; }
      case 'xor': { const a = R(rs), b = R(rt); W(rd, alu('XOR', a, b, a ^ b)); break; }
      case 'nor': { const a = R(rs), b = R(rt); W(rd, alu('NOR', a, b, ~(a | b))); break; }
      case 'andi': { const a = R(rs); W(rt, alu('AND', a, imm, a & imm)); break; }
      case 'ori': { const a = R(rs); W(rt, alu('OR', a, imm, a | imm)); break; }
      case 'xori': { const a = R(rs); W(rt, alu('XOR', a, imm, a ^ imm)); break; }
      case 'lui': W(rt, alu('<<16', imm, 16, imm << 16)); break;
      case 'slt': { const a = R(rs), b = R(rt); W(rd, alu('<', a, b, s32(a) < s32(b) ? 1 : 0)); break; }
      case 'sltu': { const a = R(rs), b = R(rt); W(rd, alu('<u', a, b, a < b ? 1 : 0)); break; }
      case 'slti': { const a = R(rs); W(rt, alu('<', a, imm, s32(a) < imm ? 1 : 0)); break; }
      case 'sltiu': { const a = R(rs); W(rt, alu('<u', a, imm, a < u32(imm) ? 1 : 0)); break; }
      case 'sll': { const a = R(rt); W(rd, alu('<<', a, shamt, a << shamt)); break; }
      case 'srl': { const a = R(rt); W(rd, alu('>>>', a, shamt, a >>> shamt)); break; }
      case 'sra': { const a = R(rt); W(rd, alu('>>', a, shamt, s32(a) >> shamt)); break; }
      case 'sllv': { const a = R(rt), b = R(rs) & 31; W(rd, alu('<<', a, b, a << b)); break; }
      case 'srlv': { const a = R(rt), b = R(rs) & 31; W(rd, alu('>>>', a, b, a >>> b)); break; }
      case 'srav': { const a = R(rt), b = R(rs) & 31; W(rd, alu('>>', a, b, s32(a) >> b)); break; }
      case 'mult': case 'multu': {
        const a = R(rs), b = R(rt);
        const p = ins.op === 'mult' ? BigInt(s32(a)) * BigInt(s32(b)) : BigInt(a) * BigInt(b);
        this.hi = Number(BigInt.asUintN(32, p >> 32n));
        this.lo = Number(BigInt.asUintN(32, p));
        this.hiLoInit = true;
        info.hiLo = { hi: this.hi, lo: this.lo };
        alu('×', a, b, this.lo);
        break;
      }
      case 'mul': {
        const a = R(rs), b = R(rt);
        W(rd, alu('×', a, b, Number(BigInt.asUintN(32, BigInt(s32(a)) * BigInt(s32(b))))));
        break;
      }
      case 'div': case 'divu': {
        const a = R(rs), b = R(rt);
        if (b === 0) throw new RuntimeError(ins.line, '0 で割りました');
        let q: number, r: number;
        if (ins.op === 'div') {
          q = Math.trunc(s32(a) / s32(b));
          r = s32(a) - q * s32(b);
        } else {
          q = Math.floor(a / b);
          r = a - q * b;
        }
        this.lo = u32(q);
        this.hi = u32(r);
        this.hiLoInit = true;
        info.hiLo = { hi: this.hi, lo: this.lo };
        alu('÷', a, b, this.lo);
        break;
      }
      case 'mfhi': case 'mflo': {
        if (!this.hiLoInit && this.opts.strictUninit) {
          throw new RuntimeError(ins.line, `${ins.op === 'mfhi' ? 'HI' : 'LO'} にはまだ値が入っていません（先に mult や div を実行します）`);
        }
        W(rd, ins.op === 'mfhi' ? this.hi : this.lo);
        break;
      }
      case 'lw': case 'lh': case 'lhu': case 'lb': case 'lbu': {
        const base = R(rs);
        const addr = u32(base + imm);
        const size = ins.op === 'lw' ? 4 : ins.op.startsWith('lh') ? 2 : 1;
        let v = this.load(addr, size, ins.line);
        if (ins.op === 'lh') v = (v << 16) >> 16;
        if (ins.op === 'lb') v = (v << 24) >> 24;
        alu('+', base, imm, addr);
        info.mem = { addr, size, value: u32(v), write: false, base: rs, baseValue: base, offset: imm };
        let un = false;
        for (let k = 0; k < size; k++) if (this.memUninit.has(u32(addr + k))) un = true;
        this.w(rt, v, info, !un);
        break;
      }
      case 'sw': case 'sh': case 'sb': {
        const base = R(rs);
        const v = this.r(rt, info, true);
        const addr = u32(base + imm);
        const size = ins.op === 'sw' ? 4 : ins.op === 'sh' ? 2 : 1;
        alu('+', base, imm, addr);
        this.store(addr, size, v, ins.line, this.init[rt]);
        const mask = size === 4 ? 0xffffffff : size === 2 ? 0xffff : 0xff;
        info.mem = { addr, size, value: u32(v & mask), write: true, base: rs, baseValue: base, offset: imm };
        break;
      }
      case 'beq': case 'bne': {
        const a = R(rs);
        const b = R(rt);
        const eq = a === b;
        const taken = ins.op === 'beq' ? eq : !eq;
        const target = u32(pc4 + imm * 4);
        alu('-', a, b, a - b);
        info.branch = { taken, a, b, pc4, offset: imm, target };
        if (taken) info.nextPc = target;
        break;
      }
      case 'j': case 'jal': {
        const target = u32((pc4 & 0xf0000000) | (ins.target & 0x0ffffffc));
        if (ins.op === 'jal') W(31, pc4);
        info.jump = { target, link: ins.op === 'jal' ? pc4 : undefined };
        info.nextPc = target;
        break;
      }
      case 'jr': case 'jalr': {
        const target = R(rs);
        if (ins.op === 'jalr') W(31, pc4);
        info.jump = { target, viaReg: rs, link: ins.op === 'jalr' ? pc4 : undefined };
        if (!this.byAddr.has(target)) {
          throw new RuntimeError(ins.line, `${ins.op} の飛び先 ${hex(target)} には命令がありません${rs === 31 ? '（$ra が上書きされていませんか？）' : ''}`);
        }
        info.nextPc = target;
        break;
      }
      case 'syscall': this.syscall(ins, info); break;
      default:
        throw new RuntimeError(ins.line, `${ins.op} はまだ実行できません`);
    }
  }

  private syscall(ins: Instr, info: ExecInfo): void {
    const code = this.r(2, info);
    const name = SYSCALL_NAME[code];
    const out = (s: string) => {
      this.output += s;
      info.syscall!.output = s;
    };
    info.syscall = { code, name: name ?? `syscall ${code}` };
    switch (code) {
      case 1: out(String(s32(this.r(4, info)))); break;
      case 4: out(this.readCString(this.r(4, info))); break;
      case 11: out(String.fromCharCode(this.r(4, info) & 0xff)); break;
      case 10:
        this.halted = true;
        info.halted = true;
        break;
      case 5: {
        const s = this.inputQueue.shift()!;
        this.cur!.input = s;
        info.syscall.input = s;
        const v = Number(s.trim());
        if (!/^[+-]?\d+$/.test(s.trim()) || !Number.isFinite(v)) {
          throw new RuntimeError(ins.line, `「${s}」は整数ではありません`);
        }
        this.output += s + '\n';
        this.w(2, v, info);
        break;
      }
      case 12: {
        const s = this.inputQueue.shift()!;
        this.cur!.input = s;
        info.syscall.input = s;
        this.output += s.slice(0, 1);
        this.w(2, s.length ? s.charCodeAt(0) : 10, info);
        break;
      }
      case 8: {
        const s = this.inputQueue.shift()!;
        this.cur!.input = s;
        info.syscall.input = s;
        const buf = this.r(4, info);
        const len = s32(this.r(5, info));
        const bytes = [...new TextEncoder().encode(s + '\n')].slice(0, Math.max(0, len - 1));
        bytes.forEach((b, k) => this.store(buf + k, 1, b, ins.line));
        if (len > 0) this.store(buf + bytes.length, 1, 0, ins.line);
        this.output += s + '\n';
        break;
      }
      default:
        throw new RuntimeError(ins.line, `syscall ${code} 番には対応していません（1・4・5・8・10・11・12 が使えます）`);
    }
  }

  /** 入力を渡す（read_int などの入力待ちのとき） */
  provideInput(s: string): void {
    this.inputQueue.push(s);
  }

  /** 連続実行。止まった理由を返す */
  run(maxSteps = 100000, breakpoints?: Set<number>): StepResult & { count: number } {
    let count = 0;
    let last: StepResult = { status: 'ok' };
    while (count < maxSteps) {
      last = this.step();
      if (last.status !== 'ok') return { ...last, count };
      count++;
      if (breakpoints && breakpoints.has(this.currentInstr()?.line ?? -1) && this.currentInstr()?.part === 0) {
        return { ...last, count };
      }
    }
    return {
      status: 'error',
      count,
      error: new RuntimeError(this.currentInstr()?.line ?? 1, `${maxSteps.toLocaleString()} 命令を実行しても終わりません。くり返しが終わっていない可能性があります`),
    };
  }
}

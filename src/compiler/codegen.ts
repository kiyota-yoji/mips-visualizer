// コード生成：構文木から MIPS のアセンブリ言語を作る（最適化はしない、教科書どおりの素直な訳）
//
// 変数の置き場所の決め方（Patterson & Hennessy の例と同じ考え方）
// - 関数を呼ばない関数（リーフ）：引数は $a0〜$a3 のまま使い、変数は $t0 から順に置く。$ra も $s も退避しない
// - 関数を呼ぶ関数・printf を使う関数：引数と変数を $s0 から順に置き、最初に $s と $ra をスタックに退避する
// - main：OS から呼ばれ、最後は syscall 10 で終わるので、$s・$ra は退避しない
// - 式の途中の値は $t レジスタ。関数を呼ぶときに使用中の $t はスタックに退避する（呼ばれた関数が自由に使うため）
import { CompileError } from './lexer';
import type { BinOp, Expr, Param, Stmt, Top, Unit } from './parser';

export type AsmKind = 'code' | 'comment' | 'label' | 'dir' | 'blank';

export interface AsmLine {
  text: string;
  kind: AsmKind;
  cLine?: number; // 対応する C の行
}

export interface FuncInfo {
  name: string;
  ret: 'int' | 'void';
  params: Param[];
  defined: boolean;
  line: number;
}

export interface CompiledFile {
  asm: AsmLine[];
  defined: string[]; // このファイルで中身を書いた関数
  called: string[]; // このファイルから呼んでいる関数
  globals: string[]; // グローバル変数（.data のラベル）
}

type Loc =
  | { k: 'reg'; reg: string }
  | { k: 'global' }
  | { k: 'garray'; size: number }
  | { k: 'larray'; off: number; size: number }
  | { k: 'parray'; reg: string };

const T_REGS = ['$t0', '$t1', '$t2', '$t3', '$t4', '$t5', '$t6', '$t7', '$t8', '$t9'];
const S_REGS = ['$s0', '$s1', '$s2', '$s3', '$s4', '$s5', '$s6', '$s7'];
const A_REGS = ['$a0', '$a1', '$a2', '$a3'];

const fitsS16 = (v: number) => v >= -32768 && v <= 32767;
const fitsU16 = (v: number) => v >= 0 && v <= 65535;

const CMP: Record<string, true> = { '<': true, '<=': true, '>': true, '>=': true, '==': true, '!=': true };

/** 式を C の書き方に戻す（コメント用） */
export function exprToC(e: Expr): string {
  switch (e.k) {
    case 'num':
      return e.char ? `'${e.v === 10 ? '\\n' : String.fromCharCode(e.v)}'` : String(e.v);
    case 'var':
      return e.name;
    case 'index':
      return `${e.name}[${exprToC(e.idx)}]`;
    case 'call':
      return `${e.name}(${e.args.map(exprToC).join(', ')})`;
    case 'str':
      return `"${e.v}"`;
    case 'unary':
      return `${e.op}${wrap(e.e)}`;
    case 'bin':
      return `${wrap(e.l)} ${e.op} ${wrap(e.r)}`;
    case 'assign':
      return `${exprToC(e.target)} ${e.op} ${exprToC(e.e)}`;
    case 'incdec':
      return e.prefix ? `${e.op}${exprToC(e.target)}` : `${exprToC(e.target)}${e.op}`;
  }
}
const wrap = (e: Expr) => (e.k === 'bin' || e.k === 'assign' ? `(${exprToC(e)})` : exprToC(e));

function containsCall(e: Expr | undefined): boolean {
  if (!e) return false;
  switch (e.k) {
    case 'call':
      return true;
    case 'index':
      return containsCall(e.idx);
    case 'unary':
      return containsCall(e.e);
    case 'bin':
      return containsCall(e.l) || containsCall(e.r);
    case 'assign':
      return containsCall(e.target) || containsCall(e.e);
    case 'incdec':
      return containsCall(e.target);
    default:
      return false;
  }
}

function walkStmts(s: Stmt, f: (s: Stmt) => void) {
  f(s);
  if (s.k === 'block') s.body.forEach((x) => walkStmts(x, f));
  if (s.k === 'if') {
    walkStmts(s.then, f);
    if (s.els) walkStmts(s.els, f);
  }
  if (s.k === 'while') walkStmts(s.body, f);
  if (s.k === 'for') {
    if (s.init) walkStmts(s.init, f);
    walkStmts(s.body, f);
  }
}
function stmtExprs(s: Stmt): Expr[] {
  switch (s.k) {
    case 'decl':
      return s.init ? [s.init] : [];
    case 'expr':
      return [s.e];
    case 'if':
    case 'while':
      return [s.cond];
    case 'for':
      return [s.cond, s.step].filter(Boolean) as Expr[];
    case 'return':
      return s.e ? [s.e] : [];
    default:
      return [];
  }
}
function walkExpr(e: Expr, f: (e: Expr) => void) {
  f(e);
  if (e.k === 'index') walkExpr(e.idx, f);
  if (e.k === 'call') e.args.forEach((a) => walkExpr(a, f));
  if (e.k === 'unary') walkExpr(e.e, f);
  if (e.k === 'bin') {
    walkExpr(e.l, f);
    walkExpr(e.r, f);
  }
  if (e.k === 'assign') {
    walkExpr(e.target, f);
    walkExpr(e.e, f);
  }
  if (e.k === 'incdec') walkExpr(e.target, f);
}

const SYSCALL_FUNCS = new Set(['printf', 'putchar']);

/** ファイルの名前（拡張子なし）から、ラベルに使える名前を作る */
export function fileBase(name: string): string {
  return name.replace(/\.[^.]*$/, '').replace(/[^\w]/g, '_') || 'file';
}

export function generate(unit: Unit, src: string, fileName: string): CompiledFile {
  const srcLines = src.split(/\r?\n/);
  const base = fileBase(fileName);
  const out: AsmLine[] = [];
  const dataOut: AsmLine[] = [];
  const funcs = new Map<string, FuncInfo>();
  const globals = new Map<string, Loc>();
  const called = new Set<string>();
  const strings: { label: string; text: string; line: number }[] = [];
  const err = (line: number, msg: string): never => {
    throw new CompileError(line, 1, msg);
  };
  const cText = (line: number) => (srcLines[line - 1] ?? '').trim().replace(/\s+/g, ' ');

  // 1回目：関数・グローバル変数の名前を集める
  for (const t of unit.tops) {
    if (t.k === 'func') {
      const prev = funcs.get(t.name);
      if (prev) {
        if (prev.params.length !== t.params.length || prev.ret !== t.ret) err(t.line, `関数 ${t.name} の宣言が ${prev.line}行目と合いません`);
        if (prev.defined && t.body) err(t.line, `関数 ${t.name} の中身を2回書いています（${prev.line}行目）`);
      }
      if (globals.has(t.name)) err(t.line, `${t.name} はもう変数の名前に使っています`);
      if (SYSCALL_FUNCS.has(t.name)) err(t.line, `${t.name} はこのコンパイラが用意している関数なので、自分では作れません`);
      funcs.set(t.name, { name: t.name, ret: t.ret, params: t.params, defined: !!t.body || !!prev?.defined, line: prev?.line ?? t.line });
    } else if (t.k === 'global') {
      if (globals.has(t.name) || funcs.has(t.name)) err(t.line, `${t.name} という名前をもう使っています`);
      globals.set(t.name, t.size ? { k: 'garray', size: t.size } : { k: 'global' });
    }
  }

  const emitTo = (arr: AsmLine[], text: string, kind: AsmKind, cLine?: number) => arr.push({ text, kind, cLine });

  // ---- .data ----
  const gl = unit.tops.filter((t): t is Extract<Top, { k: 'global' }> => t.k === 'global');

  // ---- 関数ごと ----
  for (const t of unit.tops) {
    if (t.k !== 'func' || !t.body) continue;
    genFunction(t as Extract<Top, { k: 'func' }> & { body: Extract<Stmt, { k: 'block' }> });
  }

  function genFunction(fn: Extract<Top, { k: 'func' }> & { body: Extract<Stmt, { k: 'block' }> }) {
    const isMain = fn.name === 'main';
    if (isMain && fn.params.length) err(fn.line, 'main には引数を書きません（int main(void) のように書きます）');
    // この関数で使う変数を集める（同じ名前は同じ場所にする）
    const scalars: { name: string; line: number }[] = [];
    const arrays: { name: string; size: number; line: number }[] = [];
    let usesCall = false;
    let usesSyscall = false;
    walkStmts(fn.body, (s) => {
      if (s.k === 'decl') {
        if (fn.params.some((p) => p.name === s.name)) err(s.line, `${s.name} は引数と同じ名前です`);
        if (s.size) {
          const a = arrays.find((x) => x.name === s.name);
          if (scalars.some((x) => x.name === s.name)) err(s.line, `${s.name} はもう ふつうの変数の名前に使っています`);
          if (a && a.size !== s.size) err(s.line, `配列 ${s.name} を大きさを変えて2回宣言しています`);
          if (!a) arrays.push({ name: s.name, size: s.size, line: s.line });
        } else {
          if (arrays.some((x) => x.name === s.name)) err(s.line, `${s.name} はもう配列の名前に使っています`);
          if (!scalars.some((x) => x.name === s.name)) scalars.push({ name: s.name, line: s.line });
        }
      }
      for (const e of stmtExprs(s)) {
        walkExpr(e, (x) => {
          if (x.k === 'call') {
            if (SYSCALL_FUNCS.has(x.name)) usesSyscall = true;
            else usesCall = true;
          }
        });
      }
    });
    const scalarParams = fn.params.length;
    const leaf = !usesCall && !usesSyscall && !isMain && scalars.length <= 5;
    const locs = new Map<string, Loc>();
    const savedS: string[] = [];
    let tPool = T_REGS;
    if (leaf) {
      fn.params.forEach((p, i) => locs.set(p.name, p.isArray ? { k: 'parray', reg: A_REGS[i] } : { k: 'reg', reg: A_REGS[i] }));
      scalars.forEach((s, i) => locs.set(s.name, { k: 'reg', reg: T_REGS[i] }));
      tPool = T_REGS.slice(scalars.length);
    } else {
      const all = [...fn.params.map((p) => ({ name: p.name, isArray: p.isArray, line: fn.line })), ...scalars.map((s) => ({ ...s, isArray: false }))];
      if (all.length > S_REGS.length) err(all[S_REGS.length].line, `変数が多すぎます（引数と変数をあわせて ${S_REGS.length} 個まで。$s0〜$s7 に置くため）`);
      all.forEach((v, i) => {
        locs.set(v.name, v.isArray ? { k: 'parray', reg: S_REGS[i] } : { k: 'reg', reg: S_REGS[i] });
        if (!isMain) savedS.push(S_REGS[i]);
      });
    }

    const body: AsmLine[] = [];
    let curLine = fn.line;
    let labelNo = 0;
    const used = new Set<string>();
    let maxSpill = 0;
    let spillDepth = 0;
    const loops: { brk: string; cont: string }[] = [];
    const refLabels = new Set<string>();
    const newLabel = (kind: string) => `${fn.name}_${kind}${++labelNo}`;

    // スタックの中の位置（spill → 配列）。$s・$ra の退避場所はあとで決める
    const SPILL_MARK = '\u0000SPILL';
    const ARR_MARK = '\u0000ARR';
    let arrOff = 0;
    for (const a of arrays) {
      locs.set(a.name, { k: 'larray', off: arrOff, size: a.size });
      arrOff += 4 * a.size;
    }

    const fmt = (op: string, args: string[], comment?: string) => {
      let s = `    ${op.padEnd(5)} ${args.join(', ')}`.trimEnd();
      if (comment) s = `${s.padEnd(30)} # ${comment}`;
      return s;
    };
    const emit = (op: string, args: string[], comment?: string) => body.push({ text: fmt(op, args, comment), kind: 'code', cLine: curLine });
    const label = (name: string) => body.push({ text: `${name}:`, kind: 'label', cLine: curLine });
    const comment = (text: string, line = curLine) => body.push({ text: `    # ${text}`, kind: 'comment', cLine: line });

    // ---- 一時レジスタ ----
    const alloc = (line: number): string => {
      const r = tPool.find((x) => !used.has(x));
      if (!r) return err(line, '式が複雑すぎて、一時レジスタ（$t）が足りません。式をいくつかの文に分けてください');
      used.add(r);
      return r;
    };
    const isTemp = (r: string) => tPool.includes(r) && used.has(r);
    const free = (r: string) => {
      if (tPool.includes(r)) used.delete(r);
    };

    const lookup = (name: string, line: number): Loc => {
      const l = locs.get(name) ?? globals.get(name);
      if (!l) {
        if (funcs.has(name)) err(line, `${name} は関数です（呼ぶときは ${name}(…) と書きます）`);
        err(line, `変数 ${name} が宣言されていません（int ${name}; のように先に宣言します）`);
      }
      return l!;
    };

    const spillOff = (k: number) => `${SPILL_MARK}${k}`; // あとで数に置き換える

    /** 配列の要素の番地を「base の中身 ＋ off」の形で求める */
    const addrOf = (lv: Extract<Expr, { k: 'index' }>): { base: string; off: number | string } => {
      const loc = lookup(lv.name, lv.line);
      if (loc.k === 'reg' || loc.k === 'global') err(lv.line, `${lv.name} は配列ではないので [ ] はつけられません`);
      let ie: Expr | undefined = lv.idx;
      let c = 0;
      if (ie.k === 'num') {
        c = ie.v;
        ie = undefined;
      } else if (ie.k === 'bin' && (ie.op === '+' || ie.op === '-') && ie.r.k === 'num') {
        c = ie.op === '+' ? ie.r.v : -ie.r.v;
        ie = ie.l;
      }
      let base: string;
      let off: number | string = 4 * c;
      if (loc.k === 'larray') {
        if (!ie) return { base: '$sp', off: `${ARR_MARK}${loc.off + 4 * c}` };
        base = '$sp';
        off = `${ARR_MARK}${loc.off + 4 * c}`;
      } else if (loc.k === 'garray') {
        base = alloc(lv.line);
        emit('la', [base, lv.name], `${lv.name} の先頭の番地`);
      } else base = (loc as { reg: string }).reg;
      if (ie) {
        const ir = gen(ie);
        const t = isTemp(ir) ? ir : alloc(lv.line);
        emit('sll', [t, ir, '2'], `${exprToC(ie)} × 4（1要素 4 バイト）`);
        if (isTemp(base)) {
          emit('add', [base, base, t], `${lv.name}[${exprToC(ie)}] の番地`);
          free(t);
        } else {
          emit('add', [t, base, t], `${lv.name}[${exprToC(ie)}] の番地`);
          base = t;
        }
      }
      if (typeof off === 'number' && !fitsS16(off)) err(lv.line, '配列の添字の数が大きすぎます');
      return { base, off };
    };
    const memArg = (a: { base: string; off: number | string }) => `${a.off}(${a.base})`;

    const checkCall = (e: Extract<Expr, { k: 'call' }>, needValue: boolean) => {
      const f = funcs.get(e.name);
      if (!f) err(e.line, `関数 ${e.name} が宣言されていません（ほかのファイルの関数なら、int ${e.name}(int a); のような宣言を先に書きます）`);
      if (f!.params.length !== e.args.length) err(e.line, `関数 ${e.name} の引数は ${f!.params.length} 個です（いまは ${e.args.length} 個）`);
      if (needValue && f!.ret === 'void') err(e.line, `関数 ${e.name} は値を返しません（void）`);
      e.args.forEach((a, i) => {
        const pa = f!.params[i].isArray;
        const isArr = a.k === 'var' && (() => {
          const l = locs.get(a.name) ?? globals.get(a.name);
          return l?.k === 'garray' || l?.k === 'larray' || l?.k === 'parray';
        })();
        if (pa && !isArr) err(e.line, `関数 ${e.name} の${i + 1}番目の引数には配列を渡します`);
        if (!pa && isArr) err(e.line, `関数 ${e.name} の${i + 1}番目の引数は数です（配列は渡せません）`);
      });
      called.add(e.name);
    };

    /** 関数を呼ぶ。結果は $v0 */
    const genCall = (e: Extract<Expr, { k: 'call' }>, needValue: boolean) => {
      if (SYSCALL_FUNCS.has(e.name)) {
        if (needValue) err(e.line, `${e.name} の値は使えません`);
        return genSyscallFunc(e);
      }
      checkCall(e, needValue);
      if (e.args.length && !e.args.some(containsCall)) {
        // 引数を直接 $a0〜 に入れる
        e.args.forEach((a, i) => {
          const r = gen(a, A_REGS[i]);
          if (r !== A_REGS[i]) emit('move', [A_REGS[i], r], `${i + 1}番目の引数`);
        });
      }
      const argRegs: string[] = [];
      if (e.args.some(containsCall)) {
        for (const a of e.args) {
          const r = gen(a);
          const t = isTemp(r) ? r : alloc(e.line);
          if (t !== r) emit('move', [t, r]);
          argRegs.push(t);
        }
      }
      // 使用中の一時レジスタを退避する
      const live = tPool.filter((r) => used.has(r) && !argRegs.includes(r));
      live.forEach((r, k) => emit('sw', [r, `${spillOff(spillDepth + k)}($sp)`], `${r} を退避（${e.name} が使うかもしれない）`));
      spillDepth += live.length;
      maxSpill = Math.max(maxSpill, spillDepth);
      argRegs.forEach((r, i) => {
        emit('move', [A_REGS[i], r], `${i + 1}番目の引数`);
        free(r);
      });
      emit('jal', [e.name], `${e.name} を呼ぶ（$ra ← 戻り先）`);
      spillDepth -= live.length;
      live.forEach((r, k) => emit('lw', [r, `${spillOff(spillDepth + k)}($sp)`], `${r} を元に戻す`));
    };

    const genSyscallFunc = (e: Extract<Expr, { k: 'call' }>) => {
      if (e.name === 'putchar') {
        if (e.args.length !== 1) err(e.line, 'putchar の引数は1つです');
        const r = gen(e.args[0], '$a0');
        if (r !== '$a0') emit('move', ['$a0', r]);
        free(r);
        emit('li', ['$v0', '11'], 'syscall 11：1文字を表示');
        emit('syscall', []);
        return;
      }
      // printf
      const f = e.args[0];
      if (!f || f.k !== 'str') err(e.line, 'printf の最初の引数は "…" の文字列にします');
      const fmtStr = (f as { v: string }).v;
      const pieces: ({ lit: string } | { spec: 'd' | 'c' })[] = [];
      let lit = '';
      for (let i = 0; i < fmtStr.length; i++) {
        const ch = fmtStr[i];
        if (ch === '\\') {
          lit += ch + (fmtStr[i + 1] ?? '');
          i++;
        } else if (ch === '%') {
          const n = fmtStr[i + 1];
          i++;
          if (n === '%') lit += '%';
          else if (n === 'd' || n === 'c') {
            if (lit) pieces.push({ lit });
            lit = '';
            pieces.push({ spec: n });
          } else err(e.line, `printf の %${n ?? ''} は使えません（%d・%c が使えます）`);
        } else lit += ch;
      }
      if (lit) pieces.push({ lit });
      const nSpec = pieces.filter((x) => 'spec' in x).length;
      if (nSpec !== e.args.length - 1) err(e.line, `printf の %d・%c の数（${nSpec}）と、値の数（${e.args.length - 1}）が合いません`);
      let ai = 1;
      for (const pc of pieces) {
        if ('lit' in pc) {
          const lbl = `${base}_str${strings.length + 1}`;
          strings.push({ label: lbl, text: pc.lit, line: e.line });
          emit('la', ['$a0', lbl], `"${pc.lit}" の番地`);
          emit('li', ['$v0', '4'], 'syscall 4：文字列を表示');
          emit('syscall', []);
        } else {
          const a = e.args[ai++];
          const r = gen(a, '$a0');
          if (r !== '$a0') emit('move', ['$a0', r], `${exprToC(a)} を表示する`);
          free(r);
          emit('li', ['$v0', pc.spec === 'd' ? '1' : '11'], pc.spec === 'd' ? 'syscall 1：整数を表示' : 'syscall 11：1文字を表示');
          emit('syscall', []);
        }
      }
    };

    const done = (r: string, ...others: string[]) => {
      for (const o of others) if (o !== r) free(o);
      return r;
    };

    /** 式の値を求め、入っているレジスタを返す。want があればそこに入れる */
    function gen(e: Expr, want?: string): string {
      const dst = (...srcs: string[]) => want ?? srcs.find((s) => isTemp(s)) ?? alloc(e.line);
      switch (e.k) {
        case 'num': {
          if (e.v === 0 && !want) return '$zero';
          const d = want ?? alloc(e.line);
          emit('li', [d, String(e.v)], e.char ? `'${exprToC(e).slice(1, -1)}' の文字コード` : undefined);
          return d;
        }
        case 'str':
          return err(e.line, '文字列は printf の最初の引数にだけ書けます');
        case 'var': {
          const loc = lookup(e.name, e.line);
          if (loc.k === 'reg' || loc.k === 'parray') {
            if (want && want !== loc.reg) {
              emit('move', [want, loc.reg], `${e.name} を写す`);
              return want;
            }
            return loc.reg;
          }
          const d = want ?? alloc(e.line);
          if (loc.k === 'global') {
            emit('la', [d, e.name], `グローバル変数 ${e.name} の番地`);
            emit('lw', [d, `0(${d})`], `${e.name} を読む`);
          } else if (loc.k === 'garray') emit('la', [d, e.name], `配列 ${e.name} の先頭の番地`);
          else emit('addi', [d, '$sp', `${ARR_MARK}${loc.off}`], `配列 ${e.name} の先頭の番地`);
          return d;
        }
        case 'index': {
          const a = addrOf(e);
          const d = want ?? (isTemp(a.base) ? a.base : alloc(e.line));
          emit('lw', [d, memArg(a)], `${exprToC(e)} を読む`);
          return done(d, a.base);
        }
        case 'call': {
          genCall(e, true);
          if (want === '$v0') return '$v0';
          const d = want ?? alloc(e.line);
          emit('move', [d, '$v0'], `${e.name} の結果`);
          return d;
        }
        case 'unary': {
          if (e.op === '!') {
            const r = gen(e.e);
            const d = dst(r);
            emit('sltiu', [d, r, '1'], `!${wrap(e.e)}（0 なら 1）`);
            return done(d, r);
          }
          const r = gen(e.e);
          const d = dst(r);
          if (e.op === '-') emit('sub', [d, '$zero', r], `-${wrap(e.e)}`);
          else emit('nor', [d, r, '$zero'], `~${wrap(e.e)}`);
          return done(d, r);
        }
        case 'bin':
          return genBin(e, want);
        case 'assign':
          return genAssign(e, want, true)!;
        case 'incdec':
          return genIncDec(e, want, true)!;
      }
    }

    function genBin(e: Extract<Expr, { k: 'bin' }>, want?: string): string {
      if (e.op === '&&' || e.op === '||') {
        // 値として使うとき：分岐で 0 か 1 を作る
        const d = alloc(e.line);
        const lf = newLabel('false');
        const le = newLabel('done');
        refLabels.add(lf).add(le);
        branchFalse(e, lf);
        emit('li', [d, '1']);
        emit('j', [le]);
        label(lf);
        emit('li', [d, '0']);
        label(le);
        if (want) {
          emit('move', [want, d]);
          free(d);
          return want;
        }
        return d;
      }
      const l = gen(e.l);
      const c = e.r.k === 'num' ? e.r.v : undefined;
      const text = exprToC(e);
      const imm: Partial<Record<BinOp, [string, (v: number) => boolean, ((v: number) => number)?]>> = {
        '+': ['addi', fitsS16],
        '-': ['addi', (v) => fitsS16(-v), (v) => -v],
        '&': ['andi', fitsU16],
        '|': ['ori', fitsU16],
        '^': ['xori', fitsU16],
        '<<': ['sll', (v) => v >= 0 && v < 32],
        '>>': ['sra', (v) => v >= 0 && v < 32],
        '<': ['slti', fitsS16],
      };
      const im = imm[e.op];
      if (c !== undefined && im && im[1](c)) {
        const d = want ?? (isTemp(l) ? l : alloc(e.line));
        emit(im[0], [d, l, String(im[2] ? im[2](c) : c)], text);
        return done(d, l);
      }
      const r = gen(e.r);
      const d = want ?? (isTemp(l) ? l : isTemp(r) ? r : alloc(e.line));
      switch (e.op) {
        case '+': emit('add', [d, l, r], text); break;
        case '-': emit('sub', [d, l, r], text); break;
        case '*': emit('mul', [d, l, r], text); break;
        case '/':
          emit('div', [l, r], `${text}（商は LO、あまりは HI に入る）`);
          emit('mflo', [d], '商');
          break;
        case '%':
          emit('div', [l, r], `${text}（商は LO、あまりは HI に入る）`);
          emit('mfhi', [d], 'あまり');
          break;
        case '&': emit('and', [d, l, r], text); break;
        case '|': emit('or', [d, l, r], text); break;
        case '^': emit('xor', [d, l, r], text); break;
        case '<<': emit('sllv', [d, l, r], text); break;
        case '>>': emit('srav', [d, l, r], text); break;
        case '<': emit('slt', [d, l, r], `${text} なら 1`); break;
        case '>': emit('slt', [d, r, l], `${text} なら 1`); break;
        case '<=':
          emit('slt', [d, r, l], `${wrap(e.l)} > ${wrap(e.r)} なら 1`);
          emit('xori', [d, d, '1'], `${text} なら 1（0 と 1 を入れかえる）`);
          break;
        case '>=':
          emit('slt', [d, l, r], `${wrap(e.l)} < ${wrap(e.r)} なら 1`);
          emit('xori', [d, d, '1'], `${text} なら 1（0 と 1 を入れかえる）`);
          break;
        case '==':
          emit('xor', [d, l, r], '等しければ 0');
          emit('sltiu', [d, d, '1'], `${text} なら 1`);
          break;
        case '!=':
          emit('xor', [d, l, r], '等しければ 0');
          emit('sltu', [d, '$zero', d], `${text} なら 1`);
          break;
      }
      return done(d, l, r);
    }

    /** 代入。値が要らないときは needValue = false */
    function genAssign(e: Extract<Expr, { k: 'assign' }>, want: string | undefined, needValue: boolean): string | undefined {
      const rhs: Expr = e.op === '=' ? e.e : { k: 'bin', op: e.op.slice(0, -1) as BinOp, l: e.target, r: e.e, line: e.line };
      const t = e.target;
      if (t.k === 'var') {
        const loc = lookup(t.name, t.line);
        if (loc.k === 'garray' || loc.k === 'larray' || loc.k === 'parray') err(e.line, `配列 ${t.name} には、まるごと代入できません（${t.name}[0] = … のように要素ごとに代入します）`);
        if (loc.k === 'reg') {
          const r = gen(rhs, loc.reg);
          if (r !== loc.reg) emit('move', [loc.reg, r], `${t.name} = ${exprToC(e.e)}`);
          if (want && needValue) {
            emit('move', [want, loc.reg]);
            return want;
          }
          return loc.reg;
        }
        // グローバル変数
        const v = gen(rhs);
        const a = alloc(e.line);
        emit('la', [a, t.name], `グローバル変数 ${t.name} の番地`);
        emit('sw', [v, `0(${a})`], `${t.name} に書く`);
        free(a);
        if (!needValue) {
          free(v);
          return undefined;
        }
        return v;
      }
      const v = gen(rhs);
      const a = addrOf(t);
      emit('sw', [v, memArg(a)], `${exprToC(t)} に書く`);
      free(a.base);
      if (!needValue) {
        free(v);
        return undefined;
      }
      if (want && want !== v) {
        emit('move', [want, v]);
        free(v);
        return want;
      }
      return v;
    }

    function genIncDec(e: Extract<Expr, { k: 'incdec' }>, want: string | undefined, needValue: boolean): string | undefined {
      const delta = e.op === '++' ? '1' : '-1';
      const t = e.target;
      const text = exprToC(e);
      if (t.k === 'var') {
        const loc = lookup(t.name, t.line);
        if (loc.k === 'reg') {
          let old: string | undefined;
          if (needValue && !e.prefix) {
            old = want ?? alloc(e.line);
            emit('move', [old, loc.reg], `${t.name} の前の値`);
          }
          emit('addi', [loc.reg, loc.reg, delta], text);
          if (!needValue) return undefined;
          if (old) return old;
          if (want) {
            emit('move', [want, loc.reg]);
            return want;
          }
          return loc.reg;
        }
        if (loc.k !== 'global') err(e.line, `${e.op} は配列そのものにはつけられません`);
        const a = alloc(e.line);
        const v = alloc(e.line);
        emit('la', [a, t.name], `グローバル変数 ${t.name} の番地`);
        emit('lw', [v, `0(${a})`]);
        emit('addi', [v, v, delta], text);
        emit('sw', [v, `0(${a})`]);
        free(a);
        if (!needValue) {
          free(v);
          return undefined;
        }
        if (!e.prefix) emit('addi', [v, v, delta === '1' ? '-1' : '1'], '式の値は前の値');
        return v;
      }
      const a = addrOf(t);
      const v = alloc(e.line);
      emit('lw', [v, memArg(a)], `${exprToC(t)} を読む`);
      emit('addi', [v, v, delta], text);
      emit('sw', [v, memArg(a)], `${exprToC(t)} に書く`);
      free(a.base);
      if (!needValue) {
        free(v);
        return undefined;
      }
      if (!e.prefix) emit('addi', [v, v, delta === '1' ? '-1' : '1'], '式の値は前の値');
      return v;
    }

    /** 値を使わない式（文としての式） */
    function genEffect(e: Expr) {
      if (e.k === 'assign') genAssign(e, undefined, false);
      else if (e.k === 'incdec') genIncDec(e, undefined, false);
      else if (e.k === 'call') genCall(e, false);
      else {
        const r = gen(e);
        free(r);
      }
    }

    // ---- 条件で分岐する ----
    const cmpRegs = (e: Extract<Expr, { k: 'bin' }>, needR: boolean): [string, string] => {
      const l = gen(e.l);
      let r: string;
      if (e.r.k === 'num' && e.r.v === 0) r = '$zero';
      else if (!needR && e.r.k === 'num') r = String(e.r.v);
      else r = gen(e.r);
      return [l, r];
    };
    function branchFalse(e: Expr, target: string) {
      branchIf(e, target, false);
    }
    /** e の真偽が jumpIf のとき target へ飛ぶ */
    function branchIf(e: Expr, target: string, jumpIf: boolean) {
      refLabels.add(target);
      const text = exprToC(e);
      const why = jumpIf ? `${text} なら ${target} へ` : `${text} でなければ ${target} へ`;
      if (e.k === 'unary' && e.op === '!') return branchIf(e.e, target, !jumpIf);
      if (e.k === 'bin' && (e.op === '&&' || e.op === '||')) {
        const isAnd = e.op === '&&';
        if (isAnd !== jumpIf) {
          // && で偽へ／|| で真へ：どちらかで決まれば飛ぶ
          branchIf(e.l, target, jumpIf);
          branchIf(e.r, target, jumpIf);
        } else {
          const skip = newLabel('skip');
          branchIf(e.l, skip, !jumpIf);
          branchIf(e.r, target, jumpIf);
          label(skip);
        }
        return;
      }
      if (e.k === 'bin' && CMP[e.op]) {
        if (e.op === '==' || e.op === '!=') {
          const [l, r] = cmpRegs(e, true);
          const eq = e.op === '==';
          emit(eq === jumpIf ? 'beq' : 'bne', [l, r, target], why);
          free(l);
          free(r);
          return;
        }
        // < > <= >= は slt で 0／1 を作ってから分岐
        const t = alloc(e.line);
        const swap = e.op === '>' || e.op === '<=';
        const truthWhenOne = e.op === '<' || e.op === '>';
        if (!swap && e.r.k === 'num' && fitsS16(e.r.v)) {
          const l = gen(e.l);
          emit('slti', [t, l, String(e.r.v)], `${wrap(e.l)} < ${e.r.v} なら 1`);
          free(l);
        } else {
          const l = gen(e.l);
          const r = e.r.k === 'num' && e.r.v === 0 ? '$zero' : gen(e.r);
          emit('slt', swap ? [t, r, l] : [t, l, r], swap ? `${wrap(e.r)} < ${wrap(e.l)} なら 1` : `${wrap(e.l)} < ${wrap(e.r)} なら 1`);
          free(l);
          free(r);
        }
        emit(truthWhenOne === jumpIf ? 'bne' : 'beq', [t, '$zero', target], why);
        free(t);
        return;
      }
      const r = gen(e);
      emit(jumpIf ? 'bne' : 'beq', [r, '$zero', target], why);
      free(r);
    }

    // ---- 文 ----
    const endLabel = `${fn.name}_end`;
    let lastHead = 0;
    function stmt(s: Stmt, isLast = false) {
      curLine = s.line;
      const head = () => {
        // int g = 5, h = 3; のように1行に並んだ宣言は、コメントを1回だけ書く
        if (lastHead === s.line) return;
        lastHead = s.line;
        comment(cText(s.line), s.line);
      };
      switch (s.k) {
        case 'block':
          s.body.forEach((x, i) => stmt(x, isLast && i === s.body.length - 1));
          break;
        case 'decl': {
          if (s.size) {
            if (s.arrInit) {
              head();
              const loc = locs.get(s.name) as Extract<Loc, { k: 'larray' }>;
              Array.from({ length: s.size }, (_, i) => s.arrInit![i] ?? 0).forEach((v, i) => {
                const r = v === 0 ? '$zero' : alloc(s.line);
                if (v !== 0) emit('li', [r, String(v)]);
                emit('sw', [r, `${ARR_MARK}${loc.off + 4 * i}($sp)`], `${s.name}[${i}] = ${v}`);
                free(r);
              });
            }
            break;
          }
          if (!s.init) break;
          head();
          const loc = locs.get(s.name) as Extract<Loc, { k: 'reg' }>;
          const r = gen(s.init, loc.reg);
          if (r !== loc.reg) emit('move', [loc.reg, r]);
          free(r);
          break;
        }
        case 'expr':
          head();
          genEffect(s.e);
          break;
        case 'if': {
          head();
          const lElse = newLabel('else');
          const lEnd = s.els ? newLabel('endif') : lElse;
          branchFalse(s.cond, lElse);
          stmt(s.then);
          if (s.els) {
            curLine = s.line;
            const lastCode = [...body].reverse().find((x) => x.kind === 'code');
            // then の最後が return（j）なら、else を飛びこす j は要らない
            if (!lastCode || !/^\s+j\s/.test(lastCode.text)) {
              emit('j', [lEnd], 'else の部分を飛びこす');
              refLabels.add(lEnd);
            }
            curLine = s.els.line;
            label(lElse);
            stmt(s.els, isLast);
          } else {
            curLine = s.line;
            label(lElse);
          }
          curLine = s.line;
          if (s.els && refLabels.has(lEnd)) label(lEnd);
          break;
        }
        case 'while': {
          head();
          const lLoop = newLabel('loop');
          const lExit = newLabel('exit');
          label(lLoop);
          branchFalse(s.cond, lExit);
          loops.push({ brk: lExit, cont: lLoop });
          stmt(s.body);
          loops.pop();
          curLine = s.line;
          emit('j', [lLoop], 'くり返しの最初へ戻る');
          refLabels.add(lLoop);
          label(lExit);
          break;
        }
        case 'for': {
          head();
          if (s.init) {
            if (s.init.k === 'decl') {
              const loc = locs.get(s.init.name) as Extract<Loc, { k: 'reg' }>;
              if (s.init.init) {
                const r = gen(s.init.init, loc.reg);
                if (r !== loc.reg) emit('move', [loc.reg, r]);
              }
            } else if (s.init.k === 'expr') genEffect(s.init.e);
          }
          const lLoop = newLabel('loop');
          const lNext = newLabel('next');
          const lExit = newLabel('exit');
          label(lLoop);
          if (s.cond) branchFalse(s.cond, lExit);
          loops.push({ brk: lExit, cont: lNext });
          stmt(s.body);
          loops.pop();
          curLine = s.line;
          label(lNext);
          if (s.step) genEffect(s.step);
          emit('j', [lLoop], 'くり返しの最初へ戻る');
          label(lExit);
          break;
        }
        case 'return': {
          head();
          if (isMain) {
            if (s.e && containsCall(s.e)) genEffect(s.e);
            if (!isLast) {
              emit('j', [endLabel], 'main の終わりへ');
              refLabels.add(endLabel);
            }
            break;
          }
          if (s.e) {
            if (fn.ret === 'void') err(s.line, `関数 ${fn.name} は void なので、return に値は書けません`);
            const r = gen(s.e, '$v0');
            if (r !== '$v0') emit('move', ['$v0', r], '結果を $v0 に');
            free(r);
          } else if (fn.ret === 'int') err(s.line, `関数 ${fn.name} は int なので、return に値を書きます`);
          if (!isLast) {
            emit('j', [endLabel], '関数の終わりへ');
            refLabels.add(endLabel);
          }
          break;
        }
        case 'break':
        case 'continue': {
          const lp = loops.at(-1);
          if (!lp) err(s.line, `${s.k} は while や for の中に書きます`);
          head();
          emit('j', [s.k === 'break' ? lp!.brk : lp!.cont], s.k === 'break' ? 'くり返しを抜ける' : '次のくり返しへ');
          break;
        }
      }
      if (used.size) {
        // 文の終わりで一時レジスタはすべて空く
        used.clear();
      }
    }

    fn.body.body.forEach((s, i) => stmt(s, i === fn.body.body.length - 1));

    // ---- 関数の入口と出口 ----
    const hasCall = usesCall;
    const saveRa = hasCall && !isMain;
    const spillBytes = 4 * maxSpill;
    const sOff = spillBytes + arrOff;
    const frame = sOff + 4 * savedS.length + (saveRa ? 4 : 0);
    const raOff = frame - 4;
    const fix = (s: string) =>
      s
        .replace(new RegExp(`${SPILL_MARK}(\\d+)`, 'g'), (_, k) => String(4 * Number(k)))
        .replace(new RegExp(`${ARR_MARK}(\\d+)`, 'g'), (_, k) => String(spillBytes + Number(k)));
    for (const l of body) l.text = fix(l.text);

    curLine = fn.line;
    const head: AsmLine[] = [];
    const hc = (text: string) => head.push({ text: `    # ${text}`, kind: 'comment', cLine: fn.line });
    const he = (op: string, args: string[], cm?: string) => head.push({ text: fmt(op, args, cm), kind: 'code', cLine: fn.line });
    head.push({ text: '', kind: 'blank' });
    head.push({ text: `    # ${cText(fn.line)}`, kind: 'comment', cLine: fn.line });
    if (!isMain) head.push({ text: `    .globl ${fn.name}`, kind: 'dir', cLine: fn.line });
    else head.push({ text: '    .globl main', kind: 'dir', cLine: fn.line });
    head.push({ text: `${fn.name}:`, kind: 'label', cLine: fn.line });
    const varNote = [...locs.entries()]
      .filter(([, l]) => l.k === 'reg' || l.k === 'parray')
      .map(([n, l]) => `${n}＝${(l as { reg: string }).reg}`)
      .join('、');
    if (isMain) hc('main は OS から呼ばれ、最後は syscall で終わるので $ra・$s は退避しない');
    else if (leaf) hc('関数を呼ばない（リーフ）ので、$ra も $s も退避しない');
    else if (usesCall) hc('関数を呼ぶので、引数と変数は $s に置き、$s と $ra を退避する（呼んだ先で書きかえられないように）');
    else hc('printf（syscall）で $a0 を使うので、引数と変数は $s に置き、$s を退避する');
    if (varNote) hc(`変数の置き場所：${varNote}`);
    if (frame > 0) {
      he('addi', ['$sp', '$sp', String(-frame)], `スタックに ${frame} バイトの場所をとる`);
      if (saveRa) he('sw', ['$ra', `${raOff}($sp)`], '$ra を退避（関数を呼ぶと上書きされる）');
      savedS.forEach((r, i) => he('sw', [r, `${sOff + 4 * i}($sp)`], `呼び出し元の ${r} を退避`));
    }
    if (!leaf) {
      fn.params.forEach((p, i) => {
        const loc = locs.get(p.name) as { reg: string };
        he('move', [loc.reg, A_REGS[i]], `引数 ${p.name}（$a${i}）を ${loc.reg} に写す`);
      });
    }
    void scalarParams;

    const tail: AsmLine[] = [];
    const endLine = fn.body.endLine;
    const te = (op: string, args: string[], cm?: string) => tail.push({ text: fmt(op, args, cm), kind: 'code', cLine: endLine });
    if (refLabels.has(endLabel)) tail.push({ text: `${endLabel}:`, kind: 'label', cLine: endLine });
    if (isMain) {
      tail.push({ text: '    # main の終わり：OS にプログラムの終了を頼む', kind: 'comment', cLine: endLine });
      if (frame > 0) te('addi', ['$sp', '$sp', String(frame)], 'スタックを元に戻す');
      te('li', ['$v0', '10'], 'syscall 10：終了');
      te('syscall', []);
    } else {
      if (frame > 0) tail.push({ text: '    # 戻る準備：退避したものを元に戻す', kind: 'comment', cLine: endLine });
      savedS.forEach((r, i) => te('lw', [r, `${sOff + 4 * i}($sp)`], `${r} を元に戻す`));
      if (saveRa) te('lw', ['$ra', `${raOff}($sp)`], '$ra を元に戻す');
      if (frame > 0) te('addi', ['$sp', '$sp', String(frame)], 'スタックを元に戻す');
      te('jr', ['$ra'], '呼び出し元へ戻る');
    }
    out.push(...head, ...body, ...tail);
  }

  // ---- ファイル全体を組み立てる ----
  const file: AsmLine[] = [];
  file.push({ text: `# ${fileName} をコンパイルしたもの（${base}.s）`, kind: 'comment' });
  if (gl.length || strings.length) {
    file.push({ text: '    .data', kind: 'dir' });
    for (const g of gl) {
      let d: string;
      if (g.size) {
        const vals = [...(g.arrInit ?? [])];
        const rest = g.size - vals.length;
        d = vals.length ? `.word ${vals.join(', ')}${rest > 0 ? `, 0:${rest}` : ''}` : `.word 0:${g.size}`;
      } else d = `.word ${g.init ?? 0}`;
      emitTo(dataOut, `${`${g.name}:`.padEnd(10)} ${d}`.padEnd(34) + ` # ${cText(g.line)}`, 'code', g.line);
    }
    for (const s of strings) emitTo(dataOut, `${`${s.label}:`.padEnd(10)} .asciiz "${s.text.replace(/"/g, '\\"')}"`, 'code', s.line);
    file.push(...dataOut);
  }
  file.push({ text: '', kind: 'blank' });
  file.push({ text: '    .text', kind: 'dir' });
  file.push(...out);
  return {
    asm: file,
    defined: [...funcs.values()].filter((f) => f.defined).map((f) => f.name),
    called: [...called],
    globals: gl.map((g) => g.name),
  };
}

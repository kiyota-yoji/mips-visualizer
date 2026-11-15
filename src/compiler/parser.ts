// 構文解析：トークンの列を「構文木」（プログラムの組み立て）にする。再帰下降で読む
import { CompileError, type Token, tokenize } from './lexer';

export type BinOp = '+' | '-' | '*' | '/' | '%' | '<<' | '>>' | '&' | '|' | '^' | '<' | '<=' | '>' | '>=' | '==' | '!=' | '&&' | '||';

export type Expr =
  | { k: 'num'; v: number; line: number; char?: boolean }
  | { k: 'var'; name: string; line: number }
  | { k: 'index'; name: string; idx: Expr; line: number }
  | { k: 'call'; name: string; args: Expr[]; line: number }
  | { k: 'str'; v: string; line: number }
  | { k: 'unary'; op: '-' | '!' | '~'; e: Expr; line: number }
  | { k: 'bin'; op: BinOp; l: Expr; r: Expr; line: number }
  | { k: 'assign'; op: '=' | '+=' | '-=' | '*=' | '/=' | '%='; target: LValue; e: Expr; line: number }
  | { k: 'incdec'; op: '++' | '--'; prefix: boolean; target: LValue; line: number };

export type LValue = Extract<Expr, { k: 'var' } | { k: 'index' }>;

export type Stmt =
  | { k: 'decl'; name: string; size?: number; init?: Expr; arrInit?: number[]; line: number }
  | { k: 'expr'; e: Expr; line: number }
  | { k: 'if'; cond: Expr; then: Stmt; els?: Stmt; line: number }
  | { k: 'while'; cond: Expr; body: Stmt; line: number }
  | { k: 'for'; init?: Stmt; cond?: Expr; step?: Expr; body: Stmt; line: number }
  | { k: 'return'; e?: Expr; line: number }
  | { k: 'break'; line: number }
  | { k: 'continue'; line: number }
  | { k: 'block'; body: Stmt[]; line: number; endLine: number };

export interface Param {
  name: string;
  isArray: boolean;
}

export type Top =
  | { k: 'global'; name: string; size?: number; init?: number; arrInit?: number[]; line: number }
  | { k: 'func'; ret: 'int' | 'void'; name: string; params: Param[]; body: Extract<Stmt, { k: 'block' }> | null; line: number }
  | { k: 'include'; text: string; line: number };

export interface Unit {
  tokens: Token[];
  tops: Top[];
}

const PREC: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};

export function parse(src: string): Unit {
  const tokens = tokenize(src);
  let p = 0;
  const peek = (o = 0) => tokens[Math.min(p + o, tokens.length - 1)];
  const err = (msg: string, t: Token = peek()): never => {
    throw new CompileError(t.line, t.col, msg);
  };
  const is = (text: string, o = 0) => {
    const t = peek(o);
    return (t.kind === 'punct' || t.kind === 'keyword') && t.text === text;
  };
  const accept = (text: string) => {
    if (is(text)) {
      p++;
      return true;
    }
    return false;
  };
  const expect = (text: string, what?: string): Token => {
    if (is(text)) return tokens[p++];
    const t = peek();
    const got = t.kind === 'eof' ? 'ファイルの終わり' : `「${t.text}」`;
    if (text === ';') {
      const prev = tokens[p - 1];
      return err(`${prev ? `「${prev.text}」のあとに ` : ''}; がありません（文の終わりには ; を書きます）`, prev ?? t);
    }
    return err(`${what ?? `「${text}」`}があるはずのところに ${got} があります`);
  };
  const ident = (what: string): Token => {
    const t = peek();
    if (t.kind !== 'ident') err(`${what}の名前があるはずのところに ${t.kind === 'eof' ? 'ファイルの終わり' : `「${t.text}」`} があります`);
    p++;
    return t;
  };
  const constInt = (): number => {
    const neg = accept('-');
    const t = peek();
    if (t.kind !== 'number' && t.kind !== 'char') err('ここには数（定数）を書きます');
    p++;
    return neg ? -(t.value ?? 0) | 0 : (t.value ?? 0);
  };

  // ---- 式 ----
  function primary(): Expr {
    const t = peek();
    if (t.kind === 'number' || t.kind === 'char') {
      p++;
      return { k: 'num', v: t.value ?? 0, line: t.line, char: t.kind === 'char' || undefined };
    }
    if (t.kind === 'string') {
      p++;
      return { k: 'str', v: t.str ?? '', line: t.line };
    }
    if (t.kind === 'ident') {
      p++;
      if (accept('(')) {
        const args: Expr[] = [];
        if (!is(')')) {
          do args.push(assign());
          while (accept(','));
        }
        expect(')', '関数の呼び出しを閉じる「)」');
        return { k: 'call', name: t.text, args, line: t.line };
      }
      if (accept('[')) {
        const idx = assign();
        expect(']', '「]」');
        if (is('[')) err('2次元の配列は、この教材のコンパイラでは使えません');
        return { k: 'index', name: t.text, idx, line: t.line };
      }
      return { k: 'var', name: t.text, line: t.line };
    }
    if (accept('(')) {
      const e = assign();
      expect(')', '「)」');
      return e;
    }
    return err(t.kind === 'eof' ? '式の途中でファイルが終わっています' : `式があるはずのところに「${t.text}」があります`);
  }
  function postfix(): Expr {
    const e = primary();
    if (is('++') || is('--')) {
      const op = tokens[p++].text as '++' | '--';
      if (e.k !== 'var' && e.k !== 'index') err(`${op} は変数か配列の要素につけます`);
      return { k: 'incdec', op, prefix: false, target: e as LValue, line: e.line };
    }
    return e;
  }
  function unary(): Expr {
    const t = peek();
    if (is('-') || is('!') || is('~')) {
      p++;
      const e = unary();
      if (t.text === '-' && e.k === 'num') return { ...e, v: -e.v | 0, char: undefined };
      return { k: 'unary', op: t.text as '-' | '!' | '~', e, line: t.line };
    }
    if (is('+')) {
      p++;
      return unary();
    }
    if (is('++') || is('--')) {
      p++;
      const e = unary();
      if (e.k !== 'var' && e.k !== 'index') err(`${t.text} は変数か配列の要素につけます`);
      return { k: 'incdec', op: t.text as '++' | '--', prefix: true, target: e as LValue, line: t.line };
    }
    if (is('&') || is('*')) err(`${t.text}（ポインター）は、この教材のコンパイラでは使えません`);
    return postfix();
  }
  function binary(minPrec: number): Expr {
    let l = unary();
    for (;;) {
      const t = peek();
      const prec = t.kind === 'punct' ? PREC[t.text] : undefined;
      if (prec === undefined || prec < minPrec) return l;
      p++;
      const r = binary(prec + 1);
      l = { k: 'bin', op: t.text as BinOp, l, r, line: t.line };
    }
  }
  function assign(): Expr {
    const l = binary(1);
    const t = peek();
    if (t.kind === 'punct' && ['=', '+=', '-=', '*=', '/=', '%='].includes(t.text)) {
      if (l.k !== 'var' && l.k !== 'index') err(`「${t.text}」の左には変数か配列の要素を書きます`);
      p++;
      const e = assign();
      return { k: 'assign', op: t.text as '=', target: l as LValue, e, line: t.line };
    }
    return l;
  }

  // ---- 文 ----
  function declRest(line: number): Stmt {
    const name = ident('変数').text;
    if (accept('[')) {
      let size: number | undefined;
      if (!is(']')) size = constInt();
      expect(']', '「]」');
      let arrInit: number[] | undefined;
      if (accept('=')) {
        expect('{', '「{」');
        arrInit = [];
        if (!is('}')) {
          do arrInit.push(constInt());
          while (accept(',') && !is('}'));
        }
        expect('}', '「}」');
      }
      size ??= arrInit?.length;
      if (!size || size <= 0) err(`配列 ${name} の大きさが分かりません（int ${name}[10]; のように書きます）`);
      if (arrInit && arrInit.length > size!) err(`配列 ${name} の初めの値が、大きさ ${size} より多いです`);
      return { k: 'decl', name, size, arrInit, line };
    }
    const init = accept('=') ? assign() : undefined;
    return { k: 'decl', name, init, line };
  }
  function declaration(): Stmt[] {
    const t = expect('int');
    const out: Stmt[] = [];
    do out.push(declRest(t.line));
    while (accept(','));
    expect(';');
    return out;
  }
  function block(): Extract<Stmt, { k: 'block' }> {
    const open = expect('{', '「{」');
    const body: Stmt[] = [];
    while (!is('}')) {
      if (peek().kind === 'eof') err('「{」に対応する「}」がありません', open);
      body.push(...statement());
    }
    const close = tokens[p++];
    return { k: 'block', body, line: open.line, endLine: close.line };
  }
  function one(): Stmt {
    const s = statement();
    if (s.length !== 1) return { k: 'block', body: s, line: s[0]?.line ?? peek().line, endLine: s.at(-1)?.line ?? peek().line };
    return s[0];
  }
  function statement(): Stmt[] {
    const t = peek();
    if (is('int')) return declaration();
    if (is('void')) err('void の変数は作れません');
    if (is('{')) return [block()];
    if (accept('if')) {
      expect('(', 'if のあとの「(」');
      const cond = assign();
      expect(')', '条件を閉じる「)」');
      const then = one();
      const els = accept('else') ? one() : undefined;
      return [{ k: 'if', cond, then, els, line: t.line }];
    }
    if (accept('while')) {
      expect('(', 'while のあとの「(」');
      const cond = assign();
      expect(')', '条件を閉じる「)」');
      return [{ k: 'while', cond, body: one(), line: t.line }];
    }
    if (accept('for')) {
      expect('(', 'for のあとの「(」');
      let init: Stmt | undefined;
      if (is('int')) {
        p++;
        init = declRest(t.line);
        if (is(',')) err('for の最初に宣言できる変数は1つだけです');
        expect(';');
      } else if (!accept(';')) {
        init = { k: 'expr', e: assign(), line: t.line };
        expect(';');
      }
      const cond = is(';') ? undefined : assign();
      expect(';');
      const step = is(')') ? undefined : assign();
      expect(')', 'for の「)」');
      return [{ k: 'for', init, cond, step, body: one(), line: t.line }];
    }
    if (accept('return')) {
      const e = is(';') ? undefined : assign();
      expect(';');
      return [{ k: 'return', e, line: t.line }];
    }
    if (accept('break')) {
      expect(';');
      return [{ k: 'break', line: t.line }];
    }
    if (accept('continue')) {
      expect(';');
      return [{ k: 'continue', line: t.line }];
    }
    if (accept(';')) return [];
    const e = assign();
    expect(';');
    return [{ k: 'expr', e, line: t.line }];
  }

  // ---- ファイル全体 ----
  const tops: Top[] = [];
  while (peek().kind !== 'eof') {
    const t = peek();
    if (t.kind === 'pp') {
      p++;
      if (!/^#\s*include\b/.test(t.text)) err(`${t.text.split(/\s/)[0]} は、この教材のコンパイラでは使えません（#include だけ書けます）`, t);
      tops.push({ k: 'include', text: t.text, line: t.line });
      continue;
    }
    if (!is('int') && !is('void')) err(`ここには int か void で始まる宣言を書きます（「${t.text}」があります）`);
    const ret = tokens[p++].text as 'int' | 'void';
    const name = ident(ret === 'void' ? '関数' : '変数か関数');
    if (accept('(')) {
      const params: Param[] = [];
      if (is('void') && is(')', 1)) p++;
      else if (!is(')')) {
        do {
          expect('int', '引数の型 int');
          const pn = ident('引数').text;
          let isArray = false;
          if (accept('[')) {
            expect(']', '「]」');
            isArray = true;
          }
          params.push({ name: pn, isArray });
        } while (accept(','));
      }
      expect(')', '引数を閉じる「)」');
      if (params.length > 4) err(`引数は4つまでです（$a0〜$a3 に入れて渡すため）`, name);
      if (accept(';')) {
        tops.push({ k: 'func', ret, name: name.text, params, body: null, line: t.line });
        continue;
      }
      if (!is('{')) err('関数の宣言のあとには ; か { を書きます');
      tops.push({ k: 'func', ret, name: name.text, params, body: block(), line: t.line });
      continue;
    }
    if (ret === 'void') err('void の変数は作れません', name);
    // グローバル変数
    p--;
    do {
      const nt = ident('変数');
      if (accept('[')) {
        let size: number | undefined;
        if (!is(']')) size = constInt();
        expect(']', '「]」');
        let arrInit: number[] | undefined;
        if (accept('=')) {
          expect('{', '「{」');
          arrInit = [];
          if (!is('}')) {
            do arrInit.push(constInt());
            while (accept(',') && !is('}'));
          }
          expect('}', '「}」');
        }
        size ??= arrInit?.length;
        if (!size || size <= 0) err(`配列 ${nt.text} の大きさが分かりません`, nt);
        tops.push({ k: 'global', name: nt.text, size, arrInit, line: nt.line });
      } else {
        const init = accept('=') ? constInt() : undefined;
        tops.push({ k: 'global', name: nt.text, init, line: nt.line });
      }
    } while (accept(','));
    expect(';');
  }
  return { tokens, tops };
}

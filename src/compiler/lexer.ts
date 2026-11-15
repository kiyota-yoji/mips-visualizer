// 字句解析：C のソースを「トークン」（意味のあるひとかたまり）の列にする
// この教材のコンパイラが扱うのは C の一部（int・配列・if・while・for・関数・printf）だけ

export type TokKind = 'keyword' | 'ident' | 'number' | 'char' | 'string' | 'punct' | 'pp' | 'eof';

export interface Token {
  kind: TokKind;
  text: string; // ソースに書いてあったとおりの文字
  value?: number; // 数・文字の値
  str?: string; // 文字列の中身（エスケープはそのまま。\n は \ と n の2文字）
  line: number; // 1 から
  col: number; // 1 から
  pos: number; // ソースの先頭からの位置
}

export const TOK_LABEL: Record<TokKind, string> = {
  keyword: 'キーワード',
  ident: '名前',
  number: '数',
  char: '文字',
  string: '文字列',
  punct: '記号',
  pp: '前処理',
  eof: '終わり',
};

export const KEYWORDS = new Set(['int', 'void', 'if', 'else', 'while', 'for', 'return', 'break', 'continue']);
// 知っているが、この教材では扱わないもの（分かりやすいエラーにする）
const UNSUPPORTED = new Set(['char', 'float', 'double', 'long', 'short', 'unsigned', 'signed', 'struct', 'union', 'enum', 'typedef', 'switch', 'case', 'do', 'goto', 'const', 'static', 'extern', 'sizeof']);

const PUNCTS = [
  '++', '--', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '(', ')', '{', '}', '[', ']', ';', ',', '&', '|', '^', '~',
];

export class CompileError extends Error {
  constructor(
    readonly line: number,
    readonly col: number,
    message: string,
  ) {
    super(message);
  }
}

const CHAR_ESC: Record<string, number> = { n: 10, t: 9, r: 13, '0': 0, '\\': 92, "'": 39, '"': 34 };

export function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const err = (msg: string, at = i): never => {
    throw new CompileError(line, at - lineStart + 1, msg);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '　') {
      if (c === '　') err('全角の空白があります（半角の空白にします）');
      i++;
      continue;
    }
    // コメントはトークンにしない
    if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) err('/* のコメントが */ で閉じていません');
      for (let k = i; k < end; k++) {
        if (src[k] === '\n') {
          line++;
          lineStart = k + 1;
        }
      }
      i = end + 2;
      continue;
    }
    const start = i;
    const col = i - lineStart + 1;
    const push = (kind: TokKind, extra: Partial<Token> = {}) => toks.push({ kind, text: src.slice(start, i), line, col, pos: start, ...extra });
    // #include などの前処理の行
    if (c === '#' && src.slice(lineStart, i).trim() === '') {
      while (i < src.length && src[i] !== '\n') i++;
      push('pp');
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      while (i < src.length && /\w/.test(src[i])) i++;
      const w = src.slice(start, i);
      if (UNSUPPORTED.has(w)) err(`${w} は、この教材のコンパイラでは使えません（int・void・if・while・for・return などが使えます）`, start);
      push(KEYWORDS.has(w) ? 'keyword' : 'ident');
      continue;
    }
    if (/[0-9]/.test(c)) {
      if (src.startsWith('0x', i) || src.startsWith('0X', i)) {
        i += 2;
        while (i < src.length && /[0-9a-fA-F]/.test(src[i])) i++;
      } else {
        while (i < src.length && /[0-9]/.test(src[i])) i++;
      }
      if (i < src.length && /[A-Za-z_.]/.test(src[i])) err(`数のあとに文字「${src[i]}」が続いています（小数や 10L のような書き方は使えません）`);
      const text = src.slice(start, i);
      const v = Number(text);
      if (v > 0xffffffff) err(`数 ${text} は大きすぎます（32 ビットに入りません）`, start);
      push('number', { value: v | 0 });
      continue;
    }
    if (c === "'") {
      i++;
      let v: number;
      if (src[i] === '\\') {
        const e = src[i + 1];
        if (!(e in CHAR_ESC)) err(`'\\${e}' という書き方は使えません（'\\n'・'\\t'・'\\0' が使えます）`);
        v = CHAR_ESC[e];
        i += 2;
      } else {
        const cp = src.codePointAt(i)!;
        if (cp > 127) err('文字は半角の英数字・記号だけ使えます（ASCII）');
        v = cp;
        i++;
      }
      if (src[i] !== "'") err("文字は ' と ' で1文字だけ囲みます");
      i++;
      push('char', { value: v });
      continue;
    }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\n') err('文字列が " で閉じないまま行が終わっています');
        if (src[i] === '\\') i++;
        i++;
      }
      if (i >= src.length) err('文字列が " で閉じていません');
      i++;
      push('string', { str: src.slice(start + 1, i - 1) });
      continue;
    }
    const p = PUNCTS.find((q) => src.startsWith(q, i));
    if (p) {
      i += p.length;
      push('punct');
      continue;
    }
    if (/[（）｛｝［］；，＝＋－＊／]/.test(c)) err(`全角の記号「${c}」があります（半角で書きます）`);
    err(`「${c}」という文字は C のプログラムでは使えません`);
  }
  toks.push({ kind: 'eof', text: '', line, col: i - lineStart + 1, pos: i });
  return toks;
}

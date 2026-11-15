// モード④「C から機械語へ」：C のソース → 字句解析 → 構文解析 → コード生成 → アセンブラ（.o）→ リンカ → ローダ・実行
import { exprToC } from '../compiler/codegen';
import { TOK_LABEL, type Token } from '../compiler/lexer';
import type { Expr, Stmt, Top } from '../compiler/parser';
import { type BuildResult, type FileResult, type ObjFile, type Reloc, type SourceFile, build } from '../compiler/pipeline';
import { DATA_BASE, STACK_TOP, TEXT_BASE } from '../core/defs';
import { CPRESETS, type Stage } from '../cpresets';
import { createCEditor } from './ceditor';
import { esc } from './render';

export interface CcHost {
  run(source: string, mode: 1 | 2 | 3): void;
  toast(msg: string): void;
  changed(): void; // URL・保存用
}

const STAGES: { id: Stage; label: string; group?: string }[] = [
  { id: 'tokens', label: '① 字句解析', group: 'コンパイラ' },
  { id: 'ast', label: '② 構文解析', group: 'コンパイラ' },
  { id: 'asm', label: '③ コード生成', group: 'コンパイラ' },
  { id: 'obj', label: '④ アセンブラ' },
  { id: 'link', label: '⑤ リンカ' },
  { id: 'run', label: '⑥ ローダ・実行' },
];

const h8 = (x: number) => (x >>> 0).toString(16).padStart(8, '0');
const hx = (x: number) => '0x' + h8(x);
const wordHex = (w: number) => {
  const s = h8(w).toUpperCase();
  return `${s.slice(0, 4)} ${s.slice(4)}`;
};
/** 2つの機械語を並べ、変わった桁に色をつける */
function wordDiff(a: number, b: number): [string, string] {
  const sa = wordHex(a);
  const sb = wordHex(b);
  const mark = (s: string, o: string) => [...s].map((c, i) => (c !== o[i] ? `<mark>${c}</mark>` : c)).join('');
  return [mark(sa, sb), mark(sb, sa)];
}

/** アセンブリの1行に色をつける */
function hlAsm(text: string): string {
  let code = text;
  let cm = '';
  const i = text.search(/(^|\s)#/);
  if (i >= 0 && !/"[^"]*#/.test(text.slice(0, i + 2))) {
    code = text.slice(0, i);
    cm = text.slice(i);
  }
  let html = esc(code)
    .replace(/^(\s*)([A-Za-z_.][\w.]*):/, '$1<span class="a-lbl">$2:</span>')
    .replace(/^(\s+)(\.\w+)/, '$1<span class="a-dir">$2</span>')
    .replace(/^(\s+)([a-z]+)(?=\s|$)/, '$1<span class="a-op">$2</span>')
    .replace(/(\$[a-z0-9]+)/g, '<span class="a-reg">$1</span>')
    .replace(/(&quot;.*&quot;)/, '<span class="a-str">$1</span>');
  if (cm) html += `<span class="a-cm">${esc(cm)}</span>`;
  return html;
}

export class CcView {
  private files: SourceFile[] = [];
  private cur = 0;
  private stage: Stage = 'asm';
  private presetId: string | null = null;
  private result: BuildResult | null = null;
  private timer = 0;
  private cursorLine = 1;
  private editor;
  private els: Record<string, HTMLElement> = {};

  constructor(
    private root: HTMLElement,
    private host: CcHost,
  ) {
    root.innerHTML = `
      <div class="cc-top">
        <label class="sr" for="cc-preset">C のプログラムを選ぶ</label>
        <select id="cc-preset"></select>
        <span class="preset-note" data-el="note"></span>
      </div>
      <div class="cc-flow card" data-el="flow" aria-label="翻訳と起動の流れ"></div>
      <div class="cc-layout">
        <section class="card cc-src" aria-label="C のプログラム">
          <div class="cc-files" data-el="files" role="tablist"></div>
          <div data-el="editor" class="cc-editor"></div>
          <div class="cc-msg" data-el="msg" role="status"></div>
        </section>
        <section class="card cc-stage" aria-label="それぞれの段階の結果">
          <div class="cc-stages" data-el="stages" role="tablist"></div>
          <div class="cc-body" data-el="body"></div>
        </section>
      </div>`;
    root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.els[e.dataset.el!] = e));
    this.editor = createCEditor(
      this.els.editor,
      () => {
        this.files[this.cur].source = this.editor.getDoc();
        this.presetIdIfChanged();
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => this.rebuild(), 250);
      },
      (line) => {
        this.cursorLine = line;
        this.highlightCLine(line, false);
      },
    );
    const sel = root.querySelector<HTMLSelectElement>('#cc-preset')!;
    sel.innerHTML = '<option value="">C のプログラムを選ぶ…</option>' + CPRESETS.map((p) => `<option value="${p.id}">${esc(p.title)}</option>`).join('');
    sel.addEventListener('change', () => sel.value && this.openPreset(sel.value));
    this.bindEvents();
    if (!this.loadDraft()) this.openPreset(CPRESETS[0].id);
  }

  // ---- 外から使う ----

  openPreset(id: string, stage?: Stage): boolean {
    const p = CPRESETS.find((x) => x.id === id);
    if (!p) return false;
    this.presetId = id;
    this.files = p.files.map((f) => ({ ...f }));
    this.cur = 0;
    this.stage = stage ?? p.stage ?? 'asm';
    this.loadCurrent();
    this.rebuild();
    return true;
  }

  loadFiles(files: SourceFile[], stage?: Stage) {
    this.presetId = null;
    this.files = files.length ? files : [{ name: 'main.c', source: '' }];
    this.cur = 0;
    if (stage) this.stage = stage;
    this.loadCurrent();
    this.rebuild();
  }

  shareState(): { preset: string | null; files: SourceFile[]; stage: Stage } {
    return { preset: this.presetId, files: this.files, stage: this.stage };
  }

  shown() {
    this.editor.view.requestMeasure();
  }

  // ---- 中身 ----

  private presetIdIfChanged() {
    if (!this.presetId) return;
    const p = CPRESETS.find((x) => x.id === this.presetId);
    if (!p || p.files.length !== this.files.length || p.files.some((f, i) => f.source !== this.files[i].source || f.name !== this.files[i].name)) {
      this.presetId = null;
    }
  }

  private loadCurrent() {
    const sel = this.root.querySelector<HTMLSelectElement>('#cc-preset')!;
    sel.value = this.presetId ?? '';
    const p = CPRESETS.find((x) => x.id === this.presetId);
    this.els.note.textContent = p?.note ?? '';
    this.editor.setDoc(this.files[this.cur].source);
    this.cursorLine = 1;
  }

  private saveDraft() {
    try {
      localStorage.setItem('mipsviz.cdraft', JSON.stringify({ preset: this.presetId, files: this.files, cur: this.cur, stage: this.stage }));
    } catch {
      /* 保存できない環境 */
    }
  }
  private loadDraft(): boolean {
    try {
      const d = JSON.parse(localStorage.getItem('mipsviz.cdraft') ?? 'null');
      if (!d?.files?.length) return false;
      this.files = d.files;
      this.presetId = d.preset ?? null;
      this.cur = Math.min(d.cur ?? 0, this.files.length - 1);
      this.stage = d.stage ?? 'asm';
      this.loadCurrent();
      this.rebuild();
      return true;
    } catch {
      return false;
    }
  }

  private rebuild() {
    this.result = build(this.files);
    this.saveDraft();
    this.host.changed();
    this.render();
  }

  private get fr(): FileResult | undefined {
    return this.result?.files[this.cur];
  }

  private render() {
    this.renderFiles();
    this.renderFlow();
    this.renderStages();
    this.renderMsg();
    this.renderBody();
  }

  private renderFiles() {
    this.els.files.innerHTML =
      this.files
        .map((f, i) => {
          const bad = this.result?.files[i]?.error;
          return `<span class="cc-file${i === this.cur ? ' on' : ''}${bad ? ' bad' : ''}"><button role="tab" aria-selected="${i === this.cur}" data-file="${i}" title="ダブルクリックで名前を変える">${esc(f.name)}</button>${
            this.files.length > 1 ? `<button class="cc-x" data-del="${i}" title="このファイルを消す" aria-label="${esc(f.name)} を消す">×</button>` : ''
          }</span>`;
        })
        .join('') + '<button class="cc-add" data-add title="ファイルを足す">＋ ファイル</button>';
  }

  private renderFlow() {
    const r = this.result;
    const n = this.files.length;
    const okC = (i: number) => !!r?.files[i] && !r.files[i].error;
    const linkOk = !!r?.link?.ok;
    const sel = (st: Stage[], i?: number) => (st.includes(this.stage) && (i === undefined || i === this.cur) ? ' on' : '');
    const cells: string[] = [];
    this.files.forEach((f, i) => {
      const row = `grid-row:${i + 1}`;
      const b = r?.files[i]?.base ?? f.name.replace(/\.c$/, '');
      cells.push(`<button class="fl-art fl-c${sel(['tokens'], i)}${r?.files[i]?.error ? ' bad' : ''}" style="${row};grid-column:1" data-go="tokens" data-file="${i}">${esc(f.name)}</button>`);
      cells.push(`<button class="fl-step${sel(['tokens', 'ast', 'asm'], i)}" style="${row};grid-column:2" data-go="ast" data-file="${i}"><span>コンパイラ</span></button>`);
      cells.push(`<button class="fl-art fl-s${sel(['asm'], i)}${okC(i) ? '' : ' off'}" style="${row};grid-column:3" data-go="asm" data-file="${i}">${esc(b)}.s</button>`);
      cells.push(`<button class="fl-step${sel(['obj'], i)}" style="${row};grid-column:4" data-go="obj" data-file="${i}"><span>アセンブラ</span></button>`);
      cells.push(`<button class="fl-art fl-o${sel(['obj'], i)}${okC(i) && r?.files[i]?.obj ? '' : ' off'}" style="${row};grid-column:5" data-go="obj" data-file="${i}">${esc(b)}.o</button>`);
    });
    const span = `grid-row:1 / span ${n}`;
    cells.push(`<button class="fl-step fl-tall${sel(['link'])}" style="${span};grid-column:6" data-go="link"><span>リンカ</span></button>`);
    cells.push(`<button class="fl-art fl-x${sel(['link'])}${linkOk ? '' : ' off'}${r?.link && !r.link.ok ? ' bad' : ''}" style="${span};grid-column:7" data-go="link">実行ファイル</button>`);
    cells.push(`<button class="fl-step fl-tall${sel(['run'])}" style="${span};grid-column:8" data-go="run"><span>ローダ</span></button>`);
    cells.push(`<button class="fl-art fl-m${sel(['run'])}${linkOk ? '' : ' off'}" style="${span};grid-column:9" data-go="run">メモリに置いて実行</button>`);
    this.els.flow.innerHTML = `<div class="flow-grid" style="grid-template-rows:repeat(${n}, auto)">${cells.join('')}</div>`;
  }

  private renderStages() {
    let html = '';
    let group = '';
    for (const s of STAGES) {
      if (s.group !== group) {
        if (group) html += '</span>';
        if (s.group) html += `<span class="cc-group"><span class="cc-group-name">${s.group}</span>`;
        group = s.group ?? '';
      }
      html += `<button role="tab" aria-selected="${s.id === this.stage}" data-stage="${s.id}">${s.label}</button>`;
    }
    if (group) html += '</span>';
    this.els.stages.innerHTML = html;
  }

  private renderMsg() {
    const f = this.fr;
    const msg = this.els.msg;
    if (f?.error) {
      msg.className = 'cc-msg status-error';
      msg.textContent = `${f.name} の ${f.error.line}行目：${f.error.message}`;
      this.editor.setMarks([{ line: f.error.line, kind: 'error' }]);
    } else {
      const other = this.result?.files.find((x) => x.error);
      msg.className = 'cc-msg' + (other ? ' status-error' : '');
      msg.textContent = other ? `${other.name} にエラーがあります（上のタブで ${other.name} を開きます）` : '';
      this.editor.setMarks([]);
    }
  }

  private renderBody() {
    const body = this.els.body;
    const f = this.fr;
    const need = (what: string) => `<p class="cc-wait">${what}</p>`;
    let html = '';
    switch (this.stage) {
      case 'tokens':
        html = f?.tokens ? this.htmlTokens(f.tokens) : need('字句解析のエラーを直すと表示されます。');
        break;
      case 'ast':
        html = f?.unit ? this.htmlAst(f.unit.tops) : need(f?.tokens ? '文法のエラー（構文解析のエラー）を直すと表示されます。' : 'エラーを直すと表示されます。');
        break;
      case 'asm':
        html = f?.compiled ? this.htmlAsm(f) : need('コンパイルのエラーを直すと表示されます。');
        break;
      case 'obj':
        html = f?.obj ? this.htmlObj(f.obj, f) : need('コンパイルのエラーを直すと表示されます。');
        break;
      case 'link':
        html = this.htmlLink();
        break;
      case 'run':
        html = this.htmlRun();
        break;
    }
    const top = body.scrollTop;
    body.innerHTML = html;
    body.scrollTop = top;
    this.highlightCLine(this.cursorLine, false);
  }

  // ---- ① 字句解析 ----
  private htmlTokens(toks: Token[]): string {
    const real = toks.filter((t) => t.kind !== 'eof');
    const counts = new Map<string, number>();
    for (const t of real) counts.set(t.kind, (counts.get(t.kind) ?? 0) + 1);
    const byLine = new Map<number, Token[]>();
    for (const t of real) byLine.set(t.line, [...(byLine.get(t.line) ?? []), t]);
    const lines = [...byLine.entries()]
      .map(
        ([l, ts]) =>
          `<div class="tk-line" data-c="${l}"><span class="tk-ln">${l}</span><span class="tk-chips">${ts
            .map((t) => `<button class="tk tk-${t.kind}" data-pos="${t.pos}" data-len="${t.text.length}" title="${TOK_LABEL[t.kind]}（${t.line}行${t.col}文字目）">${esc(t.text)}</button>`)
            .join('')}</span></div>`,
      )
      .join('');
    const legend = (['keyword', 'ident', 'number', 'char', 'string', 'punct', 'pp'] as const)
      .filter((k) => counts.has(k))
      .map((k) => `<span class="tk tk-${k}">${TOK_LABEL[k]} ${counts.get(k)}</span>`)
      .join('');
    return `<p class="cc-expl"><b>字句解析</b>：文字の並びを、意味のあるひとかたまり（<b>トークン</b>）に区切り、種類を見分ける。空白・改行・コメントはここで捨てる。</p>
      <p class="tk-sum">トークン <b>${real.length}</b> 個　${legend}</p>
      <div class="tk-list">${lines}</div>
      <p class="muted small">トークンを押すと、左の C のその場所を選びます。<code>#include</code> の行（前処理）は、この教材のコンパイラでは読み飛ばします。</p>`;
  }

  // ---- ② 構文解析 ----
  private htmlAst(tops: Top[]): string {
    const node = (cls: string, line: number, title: string, detail = '', kids: [string, string][] = []) =>
      `<li><span class="an an-${cls}" data-c="${line}"><b>${title}</b>${detail ? ` <code>${esc(detail)}</code>` : ''}</span>${
        kids.length ? `<ul>${kids.map(([role, k]) => k.replace('<li>', `<li>${role ? `<span class="ar">${role}</span>` : ''}`)).join('')}</ul>` : ''
      }</li>`;
    const OPN: Record<string, string> = {
      '+': '足し算', '-': '引き算', '*': 'かけ算', '/': '割り算', '%': 'あまり', '<': '小さい', '<=': '以下', '>': '大きい', '>=': '以上',
      '==': '等しい', '!=': '等しくない', '&&': 'かつ', '||': 'または', '&': 'ビットAND', '|': 'ビットOR', '^': 'ビットXOR', '<<': '左シフト', '>>': '右シフト',
    };
    const ex = (e: Expr): string => {
      switch (e.k) {
        case 'num':
          return node('leaf', e.line, e.char ? '文字' : '数', exprToC(e));
        case 'var':
          return node('leaf', e.line, '変数', e.name);
        case 'str':
          return node('leaf', e.line, '文字列', `"${e.v}"`);
        case 'index':
          return node('op', e.line, '配列の要素', `${e.name}[ ]`, [['添字', ex(e.idx)]]);
        case 'call':
          return node('call', e.line, '関数を呼ぶ', e.name, e.args.map((a, i) => [`引数${i + 1}`, ex(a)]));
        case 'unary':
          return node('op', e.line, e.op === '-' ? '符号を反対に' : e.op === '!' ? '否定' : 'ビット反転', e.op, [['', ex(e.e)]]);
        case 'bin':
          return node('op', e.line, OPN[e.op] ?? e.op, e.op, [
            ['左', ex(e.l)],
            ['右', ex(e.r)],
          ]);
        case 'assign':
          return node('op', e.line, '代入', e.op, [
            ['入れる先', ex(e.target)],
            ['値', ex(e.e)],
          ]);
        case 'incdec':
          return node('op', e.line, e.op === '++' ? '1 増やす' : '1 減らす', e.prefix ? `${e.op}x` : `x${e.op}`, [['', ex(e.target)]]);
      }
    };
    const st = (s: Stmt): string => {
      switch (s.k) {
        case 'block':
          return node('st', s.line, '{ } ブロック', '', s.body.map((x) => ['', st(x)]));
        case 'decl':
          return node('st', s.line, s.size ? '配列の宣言' : '変数の宣言', s.size ? `int ${s.name}[${s.size}]` : `int ${s.name}`, s.init ? [['初めの値', ex(s.init)]] : []);
        case 'expr':
          return node('st', s.line, '式の文', '', [['', ex(s.e)]]);
        case 'if':
          return node('st', s.line, 'if 文', '', [['条件', ex(s.cond)], ['成り立つとき', st(s.then)], ...(s.els ? ([['成り立たないとき', st(s.els)]] as [string, string][]) : [])]);
        case 'while':
          return node('st', s.line, 'while 文', '', [
            ['条件', ex(s.cond)],
            ['くり返す文', st(s.body)],
          ]);
        case 'for':
          return node('st', s.line, 'for 文', '', [
            ...(s.init ? ([['最初に', st(s.init)]] as [string, string][]) : []),
            ...(s.cond ? ([['条件', ex(s.cond)]] as [string, string][]) : []),
            ...(s.step ? ([['毎回の最後に', ex(s.step)]] as [string, string][]) : []),
            ['くり返す文', st(s.body)],
          ]);
        case 'return':
          return node('st', s.line, 'return 文', '', s.e ? [['返す値', ex(s.e)]] : []);
        case 'break':
          return node('st', s.line, 'break 文');
        case 'continue':
          return node('st', s.line, 'continue 文');
      }
    };
    const tp = (t: Top): string => {
      if (t.k === 'include') return node('pp', t.line, '前処理', t.text);
      if (t.k === 'global') return node('top', t.line, t.size ? 'グローバル配列' : 'グローバル変数', t.size ? `int ${t.name}[${t.size}]` : `int ${t.name}${t.init !== undefined ? ` = ${t.init}` : ''}`);
      const sig = `${t.ret} ${t.name}(${t.params.map((p) => `int ${p.name}${p.isArray ? '[]' : ''}`).join(', ') || 'void'})`;
      if (!t.body) return node('top', t.line, '関数の宣言（中身はほかのファイル）', sig);
      return node('top', t.line, '関数', sig, t.body.body.map((s) => ['', st(s)]));
    };
    return `<p class="cc-expl"><b>構文解析</b>：トークンの並びが C の文法に合っているかを調べ、プログラムの組み立てを<b>木</b>（構文木）にする。式は、先に計算するものほど下（葉の近く）に来る。</p>
      <div class="ast-wrap"><ul class="ast ast-root">${tops.map(tp).join('')}</ul></div>
      <p class="muted small">箱を押すと、左の C のその行を光らせます。</p>`;
  }

  // ---- ③ コード生成 ----
  private htmlAsm(f: FileResult): string {
    const c = f.compiled!;
    let parity = 0;
    let prev: number | undefined;
    const rows = c.asm
      .map((l) => {
        if (l.cLine !== prev && l.cLine !== undefined) {
          parity ^= 1;
          prev = l.cLine;
        }
        return `<div class="al al-${l.kind}${l.cLine ? ` g${parity}` : ''}"${l.cLine ? ` data-c="${l.cLine}"` : ''}><span class="al-c">${l.cLine ?? ''}</span><span class="al-t">${hlAsm(l.text) || '&nbsp;'}</span></div>`;
      })
      .join('');
    const n = c.asm.filter((l) => l.kind === 'code' && !/\.\w+/.test(l.text.trim().split(/\s/)[0])).length;
    return `<p class="cc-expl"><b>コード生成</b>：構文木をたどり、MIPS の命令に置き換えて <b>${esc(f.base)}.s</b>（アセンブリ言語）を作る。変数はレジスタに置き、if・for は条件で飛ぶ命令（<code>beq</code>・<code>bne</code>）に、関数の呼び出しは <code>jal</code> になる。</p>
      <p class="tk-sum">命令の行 <b>${n}</b> 行（<code>li</code>・<code>la</code>・<code>move</code> などの疑似命令は、アセンブラが本物の命令に直す）　<span class="muted small">左の数字は C の行。C の行にカーソルを置くと、その行から作った命令が光る</span></p>
      <div class="asm-list mono">${rows}</div>`;
  }

  // ---- ④ アセンブラ ----
  private htmlObj(o: ObjFile, f: FileResult): string {
    const rk = (r: Reloc) => (r.kind === 'J26' ? 'j・jal の番地（26ビット）' : r.kind === 'HI16' ? '番地の上16ビット' : '番地の下16ビット');
    const textRows = o.text
      .map((i) => {
        const lbl = (i.label ?? []).map((l) => `<tr class="ob-lbl"><td></td><td></td><td colspan="2">${esc(l)}:</td></tr>`).join('');
        const note = i.reloc ? (i.reloc.external ? `番地が分からない → <b>0</b> にしてメモ（${esc(i.reloc.symbol)}）` : `ファイルの中の位置で仮に入れてメモ`) : '';
        return `${lbl}<tr class="${i.reloc ? (i.reloc.external ? 'rl ext' : 'rl') : ''}" ${i.cLine ? `data-c="${i.cLine}"` : ''}><td class="mono">${i.off.toString(16).padStart(4, '0')}</td><td class="mono w">${wordHex(i.word)}</td><td class="mono">${esc(i.text)}</td><td class="small">${note}</td></tr>`;
      })
      .join('');
    const dataRows = o.data
      .map((d) => {
        const v =
          d.kind === 'asciiz' || d.kind === 'ascii'
            ? `"${esc(new TextDecoder().decode(Uint8Array.from(d.bytes.filter((b, k) => !(k === d.bytes.length - 1 && b === 0)))).replace(/\n/g, '\\n'))}"＋0（${d.bytes.length} バイト）`
            : Array.from({ length: d.bytes.length / 4 }, (_, k) => d.bytes[4 * k] | (d.bytes[4 * k + 1] << 8) | (d.bytes[4 * k + 2] << 16) | (d.bytes[4 * k + 3] << 24)).join(', ');
        return `<tr><td class="mono">${d.off.toString(16).padStart(4, '0')}</td><td class="mono">${esc(d.label)}</td><td class="mono small">${v}</td></tr>`;
      })
      .join('');
    const symRows = o.symbols
      .map(
        (s) =>
          `<tr class="${s.section === '未定義' ? 'ext' : ''}"><td class="mono">${esc(s.name)}</td><td>${s.section}</td><td class="mono">${s.section === '未定義' ? '？' : s.off.toString(16).padStart(4, '0')}</td><td>${s.global ? 'ほかのファイルから見える' : 'このファイルの中だけ'}</td><td>${s.kind}</td></tr>`,
      )
      .join('');
    const relRows = o.relocs
      .map(
        (r) =>
          `<tr class="${r.external ? 'ext' : ''}"><td class="mono">${r.off.toString(16).padStart(4, '0')}</td><td>${rk(r)}</td><td class="mono">${esc(r.symbol)}</td><td>${r.external ? 'ほかのファイル' : 'このファイル'}</td></tr>`,
      )
      .join('');
    void f;
    return `<p class="cc-expl"><b>アセンブラ</b>：命令を機械語（32ビット）にし、ラベルを番地に置き換えて <b>${esc(o.name)}</b>（オブジェクト・ファイル）を作る。番地は<b>このファイルの先頭を 0</b> として数える。ほかのファイルの関数のように<b>まだ分からない番地は 0 にして</b>、「再配置表」にメモしておく（リンカへの伝言）。</p>
      <div class="ob-grid">
        <div><h3>.text（命令の機械語）<small>${o.text.length} 命令・${o.text.length * 4} バイト</small></h3>
          <div class="ob-scroll"><table class="ob"><thead><tr><th>位置</th><th>機械語</th><th>命令</th><th></th></tr></thead><tbody>${textRows}</tbody></table></div></div>
        <div class="ob-side">
          <h3>.data（データ）<small>${o.dataSize} バイト</small></h3>
          ${o.data.length ? `<table class="ob"><thead><tr><th>位置</th><th>ラベル</th><th>中身</th></tr></thead><tbody>${dataRows}</tbody></table>` : '<p class="muted small">データはありません</p>'}
          <h3>記号表 <small>名前とその場所</small></h3>
          <table class="ob"><thead><tr><th>名前</th><th>場所</th><th>位置</th><th></th><th></th></tr></thead><tbody>${symRows}</tbody></table>
          <h3>再配置表 <small>あとで番地を直すところ</small></h3>
          ${o.relocs.length ? `<table class="ob"><thead><tr><th>位置</th><th>直すもの</th><th>記号</th><th></th></tr></thead><tbody>${relRows}</tbody></table>` : '<p class="muted small">ありません</p>'}
        </div>
      </div>
      <p class="muted small">位置・機械語は16進数。<code>beq</code>・<code>bne</code> の定数は「次の命令から何個先」なので、どこに置いても変わらず、再配置表には入らない（第07回スライド18）。</p>`;
  }

  // ---- ⑤ リンカ ----
  private htmlLink(): string {
    const r = this.result;
    const expl = `<p class="cc-expl"><b>リンカ</b>：すべての .o をつなぎ合わせて、それぞれを<b>どの番地に置くか</b>決め、再配置表のメモにしたがって番地を<b>埋める</b>。できあがりが<b>実行ファイル</b>。</p>`;
    if (!r?.link) return expl + '<p class="cc-wait">すべてのファイルのコンパイルが通ると表示されます。</p>';
    const L = r.link;
    if (!L.ok) {
      return `${expl}<div class="status-error cc-err"><b>リンカのエラー</b><ul>${L.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>
        <p class="muted small">コンパイルはファイルごとなので、ほかのファイルの関数がなくてもコンパイルは通る。足りないことが分かるのは、全部をつなぐリンカのとき。</p>`;
    }
    const totalText = L.layout.reduce((s, x) => s + x.textSize, 0);
    const mm = (kind: 'text' | 'data') =>
      L.layout
        .filter((x) => (kind === 'text' ? x.textSize : x.dataSize) > 0)
        .map((x) => {
          const st = kind === 'text' ? x.textStart : x.dataStart;
          const sz = kind === 'text' ? x.textSize : x.dataSize;
          const nm = this.result!.files.find((f) => f.name === x.file)!.base;
          return `<div class="mm-blk mm-${kind}"><span class="mono">${hx(st)}〜${hx(st + sz - 1)}</span><b>${esc(nm)}.o</b> の ${kind === 'text' ? '.text' : '.data'}<span class="muted small">${sz} バイト</span></div>`;
        })
        .join('');
    const sym = L.symbols.map((s) => `<tr><td class="mono">${esc(s.name)}</td><td class="mono">${hx(s.addr)}</td><td>${esc(s.file)}</td><td>${s.kind}</td></tr>`).join('');
    const calc = (p: (typeof L.patches)[number]) => {
      const sym = p.reloc.symbol;
      const addr = L.program!.labels.get(sym) ?? 0;
      if (p.reloc.kind === 'J26') return `${esc(sym)} の番地 ${hx(addr)} ÷ 4 の下26ビット`;
      if (p.reloc.kind === 'HI16') return `${esc(sym)} の番地 ${hx(addr)} の上16ビット`;
      return `${esc(sym)} の番地 ${hx(addr)} の下16ビット`;
    };
    const pat = L.patches
      .map((p) => {
        const [a, b] = wordDiff(p.before, p.after);
        return `<tr class="${p.reloc.external ? 'ext' : ''}"><td class="mono">${hx(p.addr)}<div class="muted small">${esc(p.file)}</div></td><td class="mono">${esc(p.text)}</td><td class="mono w">${a}<div>→ ${b}</div></td><td class="small">${calc(p)}</td></tr>`;
      })
      .join('');
    return `${expl}
      <div class="ob-grid ob-link">
        <div><h3>置き場所を決める <small>（メモリの地図）</small></h3>
          <div class="mm"><div class="mm-head">.text（命令）は ${hx(TEXT_BASE)} から</div>${mm('text')}
          <div class="mm-head">.data（データ）は ${hx(DATA_BASE)} から</div>${mm('data') || '<div class="muted small">データはありません</div>'}</div>
          <h3>記号表（全体）</h3>
          <table class="ob"><thead><tr><th>名前</th><th>番地</th><th>ファイル</th><th></th></tr></thead><tbody>${sym}</tbody></table>
        </div>
        <div><h3>番地を埋める <small>${L.patches.length} か所</small></h3>
          <div class="ob-scroll"><table class="ob"><thead><tr><th>番地</th><th>命令</th><th>.o → 実行ファイル</th><th>入れる値</th></tr></thead><tbody>${pat}</tbody></table></div>
          <p class="muted small">色のついた桁が、リンカが書きかえたところ。命令は全部で ${totalText / 4} 個。</p>
        </div>
      </div>`;
  }

  // ---- ⑥ ローダ・実行 ----
  private htmlRun(): string {
    const r = this.result;
    const expl = `<p class="cc-expl"><b>ローダ</b>：実行ファイルをメモリに置き、スタックを用意して、<b>main から実行を始める</b>（OS の仕事）。</p>`;
    if (!r?.link?.ok) return expl + '<p class="cc-wait">リンクが通ると、ここから動かせます。</p>';
    const L = r.link;
    const p = L.program!;
    const main = p.labels.get('main') ?? TEXT_BASE;
    return `${expl}
      <ul class="cc-load">
        <li>命令（.text）を <code>${hx(TEXT_BASE)}</code> から置く（${p.text.length} 命令）</li>
        <li>データ（.data）を <code>${hx(DATA_BASE)}</code> から置く（${p.data.length} バイト）</li>
        <li>スタックの先頭 <code>$sp</code> ＝ <code>${hx(STACK_TOP)}</code></li>
        <li>PC ＝ main の番地 <code>${hx(main)}</code> から始める</li>
      </ul>
      <div class="cc-run">
        <button class="primary" data-run="1">▶ ① かんたん で動かす</button>
        <button class="primary" data-run="2">▶ ② 命令の中身 で動かす</button>
        <button class="primary" data-run="3">▶ ③ ブロック図 で動かす</button>
      </div>
      <p class="muted small">動かすと、左のエディターに、全部のファイルをつないだアセンブリが入ります（コメントに C の文）。④ C から機械語へ に戻ると、C を直せます。</p>
      <details class="cc-src-all"><summary>つないだアセンブリを見る</summary><div class="asm-list mono">${L.source
        .split('\n')
        .map((t, i) => `<div class="al"${L.lineC[i] ? ` data-c="${L.lineC[i]}" data-f="${L.lineFile[i]}"` : ''}><span class="al-c">${i + 1}</span><span class="al-t">${hlAsm(t) || '&nbsp;'}</span></div>`)
        .join('')}</div></details>`;
  }

  // ---- C の行と、ほかの表示を結びつける ----
  private highlightCLine(line: number, scrollEditor: boolean) {
    const body = this.els.body;
    let first: HTMLElement | null = null;
    body.querySelectorAll<HTMLElement>('[data-c]').forEach((el) => {
      const on = Number(el.dataset.c) === line && (el.dataset.f === undefined || Number(el.dataset.f) === this.cur);
      el.classList.toggle('lit', on);
      if (on && !first) first = el;
    });
    if (first && this.stage !== 'tokens') {
      const el = first as HTMLElement;
      const box = el.closest('.asm-list, .ob-scroll, .ast-wrap, .cc-body') as HTMLElement | null;
      if (box) {
        const top = el.offsetTop - box.offsetTop;
        if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 30) box.scrollTop = top - 40;
      }
    }
    if (scrollEditor) this.editor.setMarks([{ line, kind: 'hl' }], line);
  }

  private bindEvents() {
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const go = t.closest<HTMLElement>('[data-go]');
      if (go) {
        if (go.dataset.file !== undefined) this.switchFile(Number(go.dataset.file), false);
        this.stage = go.dataset.go as Stage;
        this.saveDraft();
        this.host.changed();
        this.render();
        return;
      }
      const stg = t.closest<HTMLElement>('[data-stage]');
      if (stg) {
        this.stage = stg.dataset.stage as Stage;
        this.saveDraft();
        this.host.changed();
        this.render();
        return;
      }
      const del = t.closest<HTMLElement>('[data-del]');
      if (del) {
        const i = Number(del.dataset.del);
        if (!confirm(`${this.files[i].name} を消しますか？`)) return;
        this.files.splice(i, 1);
        this.presetId = null;
        this.cur = Math.min(this.cur, this.files.length - 1);
        this.loadCurrent();
        this.rebuild();
        return;
      }
      if (t.closest('[data-add]')) {
        let name = prompt('ファイルの名前（例 sub.c）', `file${this.files.length + 1}.c`)?.trim();
        if (!name) return;
        if (!name.endsWith('.c')) name += '.c';
        if (!/^[A-Za-z_][\w-]*\.c$/.test(name)) return this.host.toast('ファイルの名前は半角の英数字にします（例 sub.c）');
        if (this.files.some((f) => f.name === name)) return this.host.toast(`${name} はもうあります`);
        this.files.push({ name, source: `// ${name}\n` });
        this.presetId = null;
        this.cur = this.files.length - 1;
        this.loadCurrent();
        this.rebuild();
        return;
      }
      const ft = t.closest<HTMLElement>('[data-file]');
      if (ft && ft.closest('.cc-files')) {
        this.switchFile(Number(ft.dataset.file), true);
        return;
      }
      const run = t.closest<HTMLElement>('[data-run]');
      if (run && this.result?.link?.ok) {
        this.host.run(this.result.link.source, Number(run.dataset.run) as 1 | 2 | 3);
        return;
      }
      const tk = t.closest<HTMLElement>('.tk[data-pos]');
      if (tk) {
        const p = Number(tk.dataset.pos);
        this.editor.select(p, p + Number(tk.dataset.len));
        return;
      }
      const c = t.closest<HTMLElement>('[data-c]');
      if (c) {
        if (c.dataset.f !== undefined && Number(c.dataset.f) !== this.cur) this.switchFile(Number(c.dataset.f), true);
        const line = Number(c.dataset.c);
        this.cursorLine = line;
        this.highlightCLine(line, true);
      }
    });
    this.root.addEventListener('dblclick', (e) => {
      const ft = (e.target as HTMLElement).closest<HTMLElement>('.cc-files [data-file]');
      if (!ft) return;
      const i = Number(ft.dataset.file);
      let name = prompt('新しいファイルの名前', this.files[i].name)?.trim();
      if (!name) return;
      if (!name.endsWith('.c')) name += '.c';
      if (!/^[A-Za-z_][\w-]*\.c$/.test(name)) return this.host.toast('ファイルの名前は半角の英数字にします（例 sub.c）');
      this.files[i].name = name;
      this.presetId = null;
      this.rebuild();
    });
  }

  private switchFile(i: number, rerender: boolean) {
    if (i === this.cur || i < 0 || i >= this.files.length) return;
    this.cur = i;
    this.editor.setDoc(this.files[i].source);
    this.cursorLine = 1;
    this.saveDraft();
    if (rerender) this.render();
  }
}

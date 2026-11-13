// モード③ ブロック図：TD4 簡易仕様書の構成図と同じ見せ方で、1 命令のあいだにデータが通る道を動きで見せる
import type { Program } from '../core/assembler';
import { OPS, REG_NAMES, STACK_TOP, hex, s32 } from '../core/defs';
import type { ExecInfo, Machine } from '../core/machine';
import { esc, stackRowsOf, usedRegs } from './render';
import { nameAddr } from '../core/explain';

const NS = 'http://www.w3.org/2000/svg';
const W = 1030;
const H = 640;
const XHTML = 'http://www.w3.org/1999/xhtml';

type Pt = [number, number];

// ---- 部品の位置 ----
const MUX = { x: 30, y: 4, w: 170, h: 40 }; // 次の PC を選ぶ
const PC = { x: 30, y: 70, w: 170, h: 50 };
const ADD4: Pt = [300, 95];
const IMEM = { x: 8, y: 150, w: 192, h: 320 };
const DEC = { x: 240, y: 180, w: 150, h: 160 };
const REG = { x: 420, y: 130, w: 180, h: 340 };
const SEL = { x: 622, y: 290, w: 26, h: 56 }; // レジスタか定数かを選ぶ
const ALU = { x: 660, y: 220, w: 100, h: 120 };
const DATA = { x: 800, y: 110, w: 200, h: 180 }; // データ領域（.data）
const STK = { x: 800, y: 302, w: 200, h: 180 }; // スタック領域
const IO = { x: 800, y: 500, w: 200, h: 64 };
const WB = { x: 680, y: 590, w: 220, h: 28 }; // 書き込む値を選ぶ
const RD_X = 1014; // 読んだ値の線（メモリの右側を下りる）

// メモリの 2 つの領域：番地の入口・書く値の入口・読んだ値の出口の高さ
const AREA = {
  data: { r: DATA, addrY: 200, dataY: 260, outY: 240 },
  stack: { r: STK, addrY: 340, dataY: 440, outY: 420 },
};
type Area = keyof typeof AREA;
const areaOf = (addr: number): Area => (addr >= 0x7f000000 ? 'stack' : 'data');

const ALU_A: Pt = [ALU.x, 250];
const ALU_B: Pt = [ALU.x, 318];
const ALU_OUT: Pt = [ALU.x + ALU.w, 280];
const ALU_TOP: Pt = [710, ALU.y + 10];

// 色（style.css の --c-* と同じ名前）
type Color = 'pc' | 'rom' | 'reg' | 'alu' | 'sel' | 'mem' | 'io' | 'ctl';

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}

/** 番地らしい値（16進数で出す） */
const isAddrLike = (v: number) => v > 0x00400000 && v < 0x80000000;

const poly = (pts: Pt[]) => 'M' + pts.map((p) => p.join(' ')).join(' L');

// ------------------------------------------------------------
// 動きの部品（飛ばせるようにする）

class Clock {
  skipped = false;
  private timers = new Set<() => void>();

  tween(dur: number, fn: (t: number) => void): Promise<void> {
    if (this.skipped || dur <= 0) {
      fn(1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const t0 = performance.now();
      const finish = () => {
        this.timers.delete(finish);
        fn(1);
        resolve();
      };
      this.timers.add(finish);
      const frame = (now: number) => {
        if (!this.timers.has(finish)) return;
        const t = Math.min(1, (now - t0) / dur);
        if (this.skipped || t >= 1) {
          finish();
          return;
        }
        fn(t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2); // ゆっくり始まりゆっくり止まる
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  wait(ms: number): Promise<void> {
    return this.tween(ms, () => {});
  }

  skip() {
    this.skipped = true;
    for (const f of [...this.timers]) f();
  }
}

// ------------------------------------------------------------

interface Snapshot {
  pc: number;
  regs: Map<number, { v: number; init: boolean }>;
  hi: number;
  lo: number;
  hiLoInit: boolean;
  output: string;
}

const PHASES = ['① 命令を読む', '② 解読する', '③ 計算する', '④ メモリ', '⑤ 書き込む', '⑥ 次の命令へ'];

export class Diagram {
  readonly root: HTMLElement;
  private svg!: SVGSVGElement;
  private wiresLayer!: SVGGElement;
  private activeLayer!: SVGGElement;
  private chipLayer!: SVGGElement;
  private phaseBar!: HTMLElement;
  private caption!: HTMLElement;
  private prog: Program | null = null;
  private regRows = new Map<number, { y: number; val: SVGTextElement; bg: SVGRectElement }>();
  private hiRow: { y: number; val: SVGTextElement; bg: SVGRectElement } | null = null;
  private loRow: { y: number; val: SVGTextElement; bg: SVGRectElement } | null = null;
  private pcText!: SVGTextElement;
  private imemG!: SVGGElement;
  private decG!: SVGGElement;
  private aluText!: SVGTextElement;
  private aluSub!: SVGTextElement;
  private memList = new Map<Area, HTMLDivElement>();
  private ioText!: SVGTextElement;
  private blocks = new Map<string, SVGElement>();
  private clock: Clock | null = null;
  private running: Promise<void> | null = null;
  private pending: { m: Machine; lastInfo?: ExecInfo } | null = null;
  animating = false;

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = '';
    this.phaseBar = document.createElement('div');
    this.phaseBar.className = 'phases';
    this.phaseBar.innerHTML = PHASES.map((p, i) => `<span data-phase="${i}">${p}</span>`).join('');
    this.caption = document.createElement('div');
    this.caption.className = 'dg-caption';
    root.append(this.phaseBar, this.caption);
  }

  // ---- 骨組み（プログラムが変わったときだけ作り直す） ----

  setProgram(prog: Program) {
    if (this.prog === prog) return;
    this.prog = prog;
    this.svg?.remove();
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dg', role: 'img', 'aria-label': 'CPU のブロック図' });
    this.svg = svg;
    this.root.insertBefore(svg, this.caption);
    const defs = el('defs', {}, svg);
    for (const c of ['wire', 'pc', 'rom', 'reg', 'alu', 'sel', 'mem', 'io', 'ctl']) {
      const mk = el('marker', { id: `ar-${c}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
      el('path', { d: 'M0 0 L10 5 L0 10 z', class: `ar ar-${c}` }, mk);
    }
    this.wiresLayer = el('g', { class: 'wires' }, svg);
    const blocks = el('g', { class: 'blocks' }, svg);
    this.activeLayer = el('g', { class: 'active' }, svg);
    this.chipLayer = el('g', { class: 'chips' }, svg);

    // 配線（いつも見えている細い線）
    const wire = (pts: Pt[], label?: string, at?: Pt, dashed = false) => {
      el('path', { d: poly(pts), class: `w${dashed ? ' w-dash' : ''}`, 'marker-end': 'url(#ar-wire)' }, this.wiresLayer);
      if (label && at) el('text', { x: at[0], y: at[1], class: 'w-label' }, this.wiresLayer).textContent = label;
    };
    wire(this.path('pc-imem'), '番地', [120, 140]);
    wire(this.path('pc-add4'));
    wire(this.path('add4-mux'), 'PC＋4', [306, 50]);
    wire(this.path('mux-pc'));
    wire(this.path('imem-dec'), '命令', [204, 248]);
    wire(this.path('dec-reg'), '番号', [394, 212]);
    wire(this.path('dec-target'), '飛び先', [336, 70]);
    wire(this.path('dec-const'), '定数（番地のずれ）', [400, 452]);
    wire(this.path('sel-alu'));
    wire(this.path('alu-mem-data'), '番地', [764, 272]);
    wire(this.path('alu-mem-stack'));
    wire(this.path('alu-wb'), '計算の結果', [690, 582]);
    wire(this.path('mem-wb-data'), '読んだ値', [918, 600]);
    wire(this.path('mem-wb-stack'));
    wire([[REG.x + REG.w, 456], [616, 456], ...this.path('reg-mem-data', -1).slice(2)], '書く値', [728, 482]);
    wire(this.path('reg-mem-stack', -1).slice(3));
    wire(this.path('wb-reg'), '書き込む値', [540, 600]);
    wire(this.path('alu-ctl'), '比べた結果', [716, 70], true);
    wire([[ALU.x - 52, 250], ALU_A]);

    // 部品
    const block = (key: string, r: { x: number; y: number; w: number; h: number }, color: Color, title: string, sub?: string) => {
      const g = el('g', { class: `blk c-${color}` }, blocks);
      el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 8, class: 'blk-bg' }, g);
      el('text', { x: r.x + r.w / 2, y: r.y + 18, class: 'blk-title' }, g).textContent = title;
      if (sub) el('text', { x: r.x + r.w / 2, y: r.y + 33, class: 'blk-sub' }, g).textContent = sub;
      this.blocks.set(key, g);
      return g;
    };
    // 次の PC を選ぶ（台形）
    const mg = el('g', { class: 'blk c-sel' }, blocks);
    el('path', { d: `M${MUX.x} ${MUX.y} H${MUX.x + MUX.w} L${MUX.x + MUX.w - 14} ${MUX.y + MUX.h} H${MUX.x + 14} z`, class: 'blk-bg' }, mg);
    el('text', { x: MUX.x + MUX.w / 2, y: MUX.y + 25, class: 'blk-title' }, mg).textContent = '次の PC を選ぶ';
    this.blocks.set('mux', mg);

    const pcg = block('pc', PC, 'pc', 'PC（プログラムカウンタ）');
    this.pcText = el('text', { x: PC.x + PC.w / 2, y: PC.y + 40, class: 'blk-val mono' }, pcg);

    const ag = el('g', { class: 'blk c-alu' }, blocks);
    el('circle', { cx: ADD4[0], cy: ADD4[1], r: 18, class: 'blk-bg' }, ag);
    el('text', { x: ADD4[0], y: ADD4[1] + 5, class: 'blk-title' }, ag).textContent = '+4';
    this.blocks.set('add4', ag);

    this.imemG = block('imem', IMEM, 'rom', '命令メモリ', '1 命令 ＝ 4 バイト');
    this.decG = block('dec', DEC, 'alu', '命令の解読');
    const rg = block('reg', REG, 'reg', 'レジスタ', 'CPU の中の記憶');
    const sg = el('g', { class: 'blk c-sel' }, blocks);
    el('path', { d: `M${SEL.x} ${SEL.y} L${SEL.x + SEL.w} ${SEL.y + 10} V${SEL.y + SEL.h - 10} L${SEL.x} ${SEL.y + SEL.h} z`, class: 'blk-bg' }, sg);
    el('text', { x: SEL.x + SEL.w / 2, y: SEL.y - 6, class: 'blk-sub' }, sg).textContent = '選ぶ';
    this.blocks.set('sel', sg);

    const alg = el('g', { class: 'blk c-alu' }, blocks);
    el('path', { d: `M${ALU.x} ${ALU.y} L${ALU.x + ALU.w} ${ALU.y + 30} V${ALU.y + ALU.h - 30} L${ALU.x} ${ALU.y + ALU.h} V${ALU.y + 72} L${ALU.x + 16} ${ALU.y + 60} L${ALU.x} ${ALU.y + 48} z`, class: 'blk-bg' }, alg);
    el('text', { x: ALU.x + 54, y: ALU.y + 46, class: 'blk-title' }, alg).textContent = 'ALU';
    el('text', { x: ALU.x + 54, y: ALU.y + 60, class: 'blk-sub' }, alg).textContent = '演算器';
    this.aluText = el('text', { x: ALU.x + 44, y: ALU.y + 82, class: 'blk-val alu-res mono' }, alg);
    this.aluSub = el('text', { x: ALU.x + 44, y: ALU.y + 97, class: 'blk-sub mono alu-sub' }, alg);
    this.blocks.set('alu', alg);

    // メモリ：データ領域とスタック領域（中はスクロールできる表）
    const memArea = (key: Area, title: string, sub: string) => {
      const r = AREA[key].r;
      const g = block(key, r, 'mem', title, sub);
      const fo = el('foreignObject', { x: r.x + 5, y: r.y + 40, width: r.w - 10, height: r.h - 45 }, g);
      const div = document.createElementNS(XHTML, 'div') as HTMLDivElement;
      div.className = 'dm-scroll';
      fo.appendChild(div);
      this.memList.set(key, div);
    };
    memArea('data', 'データ領域（.data）', 'メモリ ・ 1 行 ＝ 4 バイト');
    memArea('stack', 'スタック領域', '上ほど番地が大きい・下へ伸びる');
    const iog = block('io', IO, 'io', '入出力（syscall）');
    this.ioText = el('text', { x: IO.x + 10, y: IO.y + 50, class: 'blk-val io-text mono' }, iog);
    const wg = el('g', { class: 'blk c-sel' }, blocks);
    el('path', { d: `M${WB.x} ${WB.y} H${WB.x + WB.w} L${WB.x + WB.w - 12} ${WB.y + WB.h} H${WB.x + 12} z`, class: 'blk-bg' }, wg);
    el('text', { x: WB.x + WB.w / 2, y: WB.y + 19, class: 'blk-sub' }, wg).textContent = '書き込む値を選ぶ';
    this.blocks.set('wb', wg);

    // レジスタの行（使っているものだけ）
    this.regRows.clear();
    const regs = usedRegs(prog);
    if (prog.text.some((i) => i.rs === 29 || i.rt === 29) && !regs.includes(29)) regs.push(29);
    regs.sort((a, b) => a - b);
    const useHiLo = prog.text.some((i) => ['mult', 'multu', 'div', 'divu', 'mfhi', 'mflo'].includes(i.op));
    const n = regs.length + (useHiLo ? 2 : 0);
    const top = REG.y + 44;
    const rowH = Math.min(26, (REG.y + REG.h - 8 - top) / Math.max(n, 1));
    const mkRow = (name: string, i: number) => {
      const y = top + i * rowH + rowH / 2;
      const bg = el('rect', { x: REG.x + 8, y: y - rowH / 2 + 1, width: REG.w - 16, height: rowH - 2, rx: 4, class: 'row' }, rg);
      el('text', { x: REG.x + 16, y: y + 5, class: 'row-name mono' }, rg).textContent = name;
      const val = el('text', { x: REG.x + REG.w - 16, y: y + 5, class: 'row-val mono' }, rg);
      return { y, val, bg };
    };
    regs.forEach((r, i) => this.regRows.set(r, mkRow('$' + REG_NAMES[r], i)));
    this.hiRow = useHiLo ? mkRow('HI', regs.length) : null;
    this.loRow = useHiLo ? mkRow('LO', regs.length + 1) : null;
  }

  // ---- 道筋 ----

  private rowY(reg: number): number {
    return this.regRows.get(reg)?.y ?? REG.y + REG.h / 2;
  }

  private path(name: string, reg?: number): Pt[] {
    const ry = reg !== undefined ? this.rowY(reg) : 0;
    const R = REG.x + REG.w;
    switch (name) {
      case 'pc-imem': return [[115, PC.y + PC.h], [115, IMEM.y]];
      case 'pc-add4': return [[PC.x + PC.w, ADD4[1]], [ADD4[0] - 18, ADD4[1]]];
      case 'add4-mux': return [[ADD4[0], ADD4[1] - 18], [ADD4[0], 12], [MUX.x + MUX.w - 2, 12]];
      case 'mux-pc': return [[115, MUX.y + MUX.h], [115, PC.y]];
      case 'imem-dec': return [[IMEM.x + IMEM.w, 258], [DEC.x, 258]];
      case 'dec-reg': return [[DEC.x + DEC.w, 220], [REG.x, 220]];
      case 'dec-target': return [[330, DEC.y], [330, 34], [MUX.x + MUX.w - 10, 34]];
      case 'dec-const': return [[DEC.x + 60, DEC.y + DEC.h], [DEC.x + 60, 440], [SEL.x + 13, 440], [SEL.x + 13, SEL.y + SEL.h - 4]];
      case 'sel-alu': return [[SEL.x + SEL.w, 318], ALU_B];
      case 'alu-mem-data': return [ALU_OUT, [786, 280], [786, AREA.data.addrY], [DATA.x, AREA.data.addrY]];
      case 'alu-mem-stack': return [ALU_OUT, [786, 280], [786, AREA.stack.addrY], [STK.x, AREA.stack.addrY]];
      case 'alu-wb': return [[776, 280], [776, WB.y]];
      case 'mem-wb-data': return [[DATA.x + DATA.w, AREA.data.outY], [RD_X, AREA.data.outY], [RD_X, WB.y + 14], [WB.x + WB.w - 6, WB.y + 14]];
      case 'mem-wb-stack': return [[STK.x + STK.w, AREA.stack.outY], [RD_X, AREA.stack.outY], [RD_X, WB.y + 14], [WB.x + WB.w - 6, WB.y + 14]];
      case 'wb-reg': return [[WB.x, WB.y + 14], [412, WB.y + 14], [412, REG.y + REG.h - 24], [REG.x, REG.y + REG.h - 24]];
      case 'alu-ctl': return [ALU_TOP, [ALU_TOP[0], 58], [MUX.x + MUX.w - 20, 58], [MUX.x + MUX.w - 20, MUX.y + MUX.h - 2]];
      // レジスタの行から
      case 'reg-a': return [[R, ry], [612, ry], [612, 250], ALU_A];
      case 'reg-b': return [[R, ry], [604, ry], [604, 305], [SEL.x + 2, 305]];
      case 'reg-mem-data': return [[R, ry], [616, ry], [616, 488], [794, 488], [794, AREA.data.dataY], [DATA.x, AREA.data.dataY]];
      case 'reg-mem-stack': return [[R, ry], [616, ry], [616, 488], [794, 488], [794, AREA.stack.dataY], [STK.x, AREA.stack.dataY]];
      case 'reg-io': return [[R, ry], [620, ry], [620, 532], [IO.x, 532]];
      case 'reg-mux': return [[510, REG.y], [510, 36], [MUX.x + MUX.w - 8, 36]];
      case 'wb-row': return [[WB.x, WB.y + 14], [412, WB.y + 14], [412, ry], [REG.x + 6, ry]];
      case 'add4-row': return [[ADD4[0] + 18, ADD4[1]], [404, ADD4[1]], [404, ry], [REG.x, ry]];
      case 'io-wb': return [[880, IO.y + IO.h], [880, WB.y]];
      case 'row-row': return [];
    }
    return [];
  }

  // ---- 表示（止まっているとき） ----

  private snapshot(m: Machine): Snapshot {
    const regs = new Map<number, { v: number; init: boolean }>();
    for (let i = 0; i < 32; i++) regs.set(i, { v: m.regs[i], init: m.init[i] });
    return { pc: m.pc, regs, hi: m.hi, lo: m.lo, hiLoInit: m.hiLoInit, output: m.output };
  }

  private before(m: Machine, info: ExecInfo): Snapshot {
    const s = this.snapshot(m);
    s.pc = info.pc;
    // 実行前の値に戻す（値が入っていたかどうかは履歴から）
    const undo = m.history.at(-1);
    if (undo && undo.info === info) for (const [i, v, ini] of [...undo.regs].reverse()) s.regs.set(i, { v, init: ini });
    else for (const w of [...info.writes].reverse()) s.regs.set(w.reg, { v: w.old, init: true });
    if (info.hiLo) {
      s.hi = info.hiLo.oldHi;
      s.lo = info.hiLo.oldLo;
      s.hiLoInit = info.hiLo.oldInit;
    }
    if (info.syscall?.output) s.output = s.output.slice(0, s.output.length - info.syscall.output.length);
    return s;
  }

  /** ポップアップ（2進・16進）用に値を持たせる。null なら値なし */
  private setV(row: { val: SVGTextElement; bg: SVGRectElement }, v: number | null) {
    for (const e of [row.val, row.bg]) {
      if (v === null) e.removeAttribute('data-v');
      else e.setAttribute('data-v', String(v >>> 0));
    }
  }

  private drawRegs(s: Snapshot) {
    for (const [r, row] of this.regRows) {
      const x = s.regs.get(r)!;
      row.val.textContent = x.init ? (r >= 28 || isAddrLike(x.v) ? hex(x.v) : String(s32(x.v))) : '？';
      row.val.classList.toggle('uninit', !x.init);
      this.setV(row, x.init ? x.v : null);
    }
    for (const [row, v] of [[this.hiRow, s.hi], [this.loRow, s.lo]] as const) {
      if (!row) continue;
      row.val.textContent = s.hiLoInit ? String(s32(v)) : '？';
      this.setV(row, s.hiLoInit ? v : null);
    }
  }

  private drawPc(pc: number) {
    this.pcText.textContent = hex(pc);
    // 命令メモリ：PC のまわりの命令
    this.imemG.querySelectorAll('.im').forEach((e) => e.remove());
    const text = this.prog!.text;
    let idx = text.findIndex((i) => i.addr === pc);
    if (idx < 0) idx = text.length;
    const rows = 11;
    const start = Math.max(0, Math.min(idx - 3, text.length - rows));
    for (let k = 0; k < rows && start + k < text.length; k++) {
      const ins = text[start + k];
      const y = IMEM.y + 50 + k * 24;
      const cur = start + k === idx;
      if (cur) el('rect', { x: IMEM.x + 6, y: y - 15, width: IMEM.w - 12, height: 21, rx: 4, class: 'im im-cur' }, this.imemG);
      const t = el('text', { x: IMEM.x + 12, y, class: `im im-line mono${cur ? ' cur' : ''}` }, this.imemG);
      const a = el('tspan', { class: 'im-addr' }, t);
      a.textContent = (ins.addr & 0xffff).toString(16).padStart(4, '0') + ' ';
      const body = el('tspan', {}, t);
      body.textContent = ins.text.length > 21 ? ins.text.slice(0, 20) + '…' : ins.text;
    }
  }

  private drawDec(info?: ExecInfo, show = true) {
    this.decG.querySelectorAll('.dl').forEach((e) => e.remove());
    if (!info || !show) {
      el('text', { x: DEC.x + DEC.w / 2, y: DEC.y + 80, class: 'dl blk-sub' }, this.decG).textContent = '（命令を待っている）';
      return;
    }
    const ins = info.instr;
    const def = OPS[ins.op];
    const lines: string[] = [];
    if (def.format === 'R') {
      if (ins.op === 'syscall') lines.push('$v0 の番号の仕事');
      else {
        if (def.syntax.includes('s')) lines.push(`rs ＝ $${REG_NAMES[ins.rs]}`);
        if (def.syntax.includes('t')) lines.push(`rt ＝ $${REG_NAMES[ins.rt]}`);
        if (def.syntax.includes('d')) lines.push(`rd ＝ $${REG_NAMES[ins.rd]}（書く）`);
        if (def.syntax.includes('h')) lines.push(`shamt ＝ ${ins.shamt}`);
      }
    } else if (def.format === 'I') {
      lines.push(`rs ＝ $${REG_NAMES[ins.rs]}`);
      lines.push(`rt ＝ $${REG_NAMES[ins.rt]}${def.group === 'mem' && ins.op.startsWith('s') ? '' : def.group === 'branch' ? '' : '（書く）'}`);
      lines.push(`${def.group === 'branch' ? '飛ぶ命令の数' : def.group === 'mem' ? 'ずれ' : '定数'} ＝ ${ins.imm}`);
    } else {
      lines.push(`飛び先 ＝ ${ins.targetLabel ?? hex(ins.target)}`);
    }
    el('text', { x: DEC.x + DEC.w / 2, y: DEC.y + 46, class: `dl dec-op g-${def.group}` }, this.decG).textContent = ins.op;
    el('text', { x: DEC.x + DEC.w / 2, y: DEC.y + 62, class: 'dl blk-sub' }, this.decG).textContent = `${def.format} 形式`;
    lines.forEach((l, k) => {
      el('text', { x: DEC.x + 12, y: DEC.y + 86 + k * 18, class: 'dl dec-line mono' }, this.decG).textContent = l;
    });
  }

  /**
   * データ領域とスタック領域の表。focus の行を目立たせて見える位置までスクロールする。
   * focusOld を渡すと、その行は書き込む前の値で出す（札が着くまで）。
   */
  private drawMem(m: Machine, sp: number, focus?: number, focusOld?: number) {
    const prog = this.prog!;
    const fw = focus !== undefined ? focus & ~3 : undefined;
    const valCell = (v: number, show = true) =>
      show ? `<span class="dm-v" data-v="${v >>> 0}">${esc(isAddrLike(v) ? hex(v) : String(s32(v)))}</span>` : '<span class="dm-v dm-empty">—</span>';
    const row = (a: number, v: number, note: string, cls: string, show = true) =>
      `<div class="dm-row ${cls}${a === fw ? ' dm-cur' : ''}" data-addr="${a}"><span class="dm-a">${hex(a).slice(2)}</span>${valCell(a === fw && focusOld !== undefined ? focusOld : v, show)}<span class="dm-n">${esc(note)}</span></div>`;

    // データ領域
    const size = Math.max(prog.data.length, 4);
    const labelAt = new Map<number, string>();
    for (const d of prog.dataLabels) if (!labelAt.has(d.addr & ~3)) labelAt.set(d.addr & ~3, d.name);
    let html = '';
    if (!prog.data.length) html = '<div class="dm-none">（.data はない）</div>';
    else
      for (let a = 0x10010000, k = 0; a < 0x10010000 + size && k < 256; a += 4, k++) {
        const nm = labelAt.get(a) ?? nameAddr(prog, a);
        html += row(a, m.readWord(a), nm.startsWith('0x') ? '' : nm, labelAt.has(a) ? 'dm-lbl' : '');
      }
    this.fillList('data', html, fw !== undefined && areaOf(fw) === 'data' ? fw : undefined);

    // スタック領域：最初の $sp から、いま使っているところの少し下まで
    const { rows } = stackRowsOf(m, sp, 6);
    html = rows
      .map((r) => row(r.addr, r.value, [r.saved && r.inUse ? `${r.saved} を退避` : '', r.isSp ? '← $sp' : r.addr === STACK_TOP ? '最初の $sp' : ''].filter(Boolean).join('　'), r.inUse ? 'dm-use' : 'dm-free', r.inUse || !!r.saved || r.addr === fw))
      .join('');
    this.fillList('stack', html, fw !== undefined && areaOf(fw) === 'stack' ? fw : undefined);
  }

  private fillList(key: Area, html: string, focus?: number) {
    const div = this.memList.get(key);
    if (!div) return;
    const top = div.scrollTop;
    div.innerHTML = html;
    div.scrollTop = top; // 学生がスクロールした位置は保つ
    if (focus === undefined) return;
    const r = div.querySelector<HTMLElement>(`[data-addr="${focus}"]`);
    if (!r) return;
    if (r.offsetTop < div.scrollTop || r.offsetTop + r.offsetHeight > div.scrollTop + div.clientHeight) {
      div.scrollTop = r.offsetTop - div.clientHeight / 2 + r.offsetHeight / 2;
    }
  }

  private setPhase(i: number | null) {
    this.phaseBar.querySelectorAll('span').forEach((s) => s.classList.toggle('on', Number(s.dataset.phase) === i));
  }

  private lit(keys: string[]) {
    for (const [k, g] of this.blocks) g.classList.toggle('lit', keys.includes(k));
  }

  /** 止まっている状態を描く */
  show(m: Machine, lastInfo?: ExecInfo, keepFlow = false) {
    if (this.animating) {
      // 動いている途中に画面が変わった（戻る・最初から など）：動きが終わったらこちらを描く
      this.pending = { m, lastInfo };
      return;
    }
    this.setProgram(m.prog);
    // 動きのあとは、札と通った線をそのまま残す（次の命令を始めるまで）
    if (!keepFlow) this.clearActive();
    const s = this.snapshot(m);
    this.drawRegs(s);
    this.drawPc(m.pc);
    this.drawDec(lastInfo);
    this.drawMem(m, m.regs[29], lastInfo?.mem?.addr);
    this.ioText.textContent = lastOutputLine(m.output);
    this.aluText.textContent = lastInfo?.alu ? aluResultText(lastInfo) : '';
    this.aluSub.textContent = lastInfo?.alu ? aluFormula(lastInfo) : '';
    if (!keepFlow) this.setPhase(null);
    this.lit([]);
    for (const row of this.regRows.values()) row.bg.classList.remove('rd', 'wr');
    if (lastInfo) {
      for (const r of lastInfo.reads) this.regRows.get(r.reg)?.bg.classList.add('rd');
      for (const w of lastInfo.writes) this.regRows.get(w.reg)?.bg.classList.add('wr');
    }
    if (!keepFlow || m.halted) this.caption.textContent = m.halted ? 'プログラムは終わりました。' : '「1ステップ」で、次の命令のデータの流れを動きで見せます。';
    else this.chipLayer.querySelectorAll('.chip').forEach((c) => c.classList.remove('old'));
  }

  // ---- 動き ----

  private clearActive() {
    this.activeLayer?.replaceChildren();
    this.chipLayer?.replaceChildren();
  }

  /**
   * 道に沿ってチップ（値の札）を動かす。通ったあとの線は色が残り、札は着いたところに残る。
   * back は、ほかの札と重ならないように手前で止める長さ。
   */
  private async move(pts: Pt[], label: string, color: Color, dur: number, back = 0): Promise<void> {
    if (pts.length < 2) return;
    const clock = this.clock ?? new Clock();
    const trail = el('path', { d: poly(pts), class: `trail t-${color}`, 'marker-end': `url(#ar-${color})` }, this.activeLayer);
    const len = trail.getTotalLength();
    trail.style.strokeDasharray = `${len}`;
    trail.style.strokeDashoffset = `${len}`;
    const chip = el('g', { class: `chip k-${color}` }, this.chipLayer);
    const w = Math.max(28, label.length * 7.4 + 14);
    const inner = el('g', { class: 'chip-in' }, chip);
    el('rect', { x: -w / 2, y: -11, width: w, height: 22, rx: 11 }, inner);
    el('text', { x: 0, y: 4.5 }, inner).textContent = label;
    if (!label) chip.style.display = 'none';
    const stop = Math.max(len * 0.45, len - w / 2 - 10 - back); // 矢印の手前で止まる
    await clock.tween(dur, (t) => {
      const p = trail.getPointAtLength(stop * t);
      chip.setAttribute('transform', `translate(${p.x} ${p.y})`);
      trail.style.strokeDashoffset = `${len - stop * t}`;
    });
    trail.style.strokeDashoffset = '0';
    chip.classList.add('landed');
  }

  private pulse(g: SVGElement | undefined) {
    if (!g) return;
    g.classList.remove('pulse');
    void (g as unknown as HTMLElement).getBoundingClientRect();
    g.classList.add('pulse');
  }

  private async phase(i: number, text: string, unit: number) {
    this.setPhase(i);
    // 前の段階の札は薄くして残す
    this.chipLayer.querySelectorAll('.chip').forEach((c) => c.classList.add('old'));
    this.caption.textContent = text;
    await this.clock!.wait(unit * 0.15);
  }

  skip() {
    this.clock?.skip();
  }

  /**
   * 1 命令の動き。m は実行したあとの状態、info はその命令の情報。
   * speed は 1 で約 3 秒（ゆっくり 1.5・速い 0.4）
   */
  async animate(m: Machine, info: ExecInfo, speed: number): Promise<void> {
    // 前の動きが残っていれば、飛ばして終わるのを待ってから始める（札が混ざらないように）
    while (this.running) {
      this.clock?.skip();
      await this.running;
    }
    this.pending = null;
    this.setProgram(m.prog);
    const clock = new Clock();
    this.clock = clock;
    this.animating = true;
    const run = this.play(m, info, speed * 500).finally(() => {
      this.animating = false;
      this.clock = null;
      this.running = null;
    });
    this.running = run.catch(() => {});
    await run;
    const p = this.pending as { m: Machine; lastInfo?: ExecInfo } | null; // 待っている間に入ることがある
    this.pending = null;
    if (p) this.show(p.m, p.lastInfo);
    else this.show(m, info, true);
  }

  private async play(m: Machine, info: ExecInfo, u: number) {
    const ins = info.instr;
    const def = OPS[ins.op];
    const b = this.before(m, info);
    this.clearActive();
    this.drawRegs(b);
    this.drawPc(info.pc);
    this.drawDec(undefined);
    this.drawMem(m, b.regs.get(29)!.v, info.mem?.addr, info.mem?.write ? info.mem.old : undefined);
    this.ioText.textContent = lastOutputLine(b.output);
    this.aluText.textContent = '';
    this.aluSub.textContent = '';
    for (const row of this.regRows.values()) row.bg.classList.remove('rd', 'wr');
    const R = (r: number) => '$' + REG_NAMES[r];
    const val = (r: number) => (r === 0 ? 0 : info.reads.find((x) => x.reg === r)?.value ?? b.regs.get(r)!.v);
    const vs = (v: number) => (v >= 0x00400000 && v < 0x80000000 && v > 0x00400000 ? hex(v) : String(s32(v)));
    const rowLit = (r: number, cls: 'rd' | 'wr') => this.regRows.get(r)?.bg.classList.add(cls);

    // ① 命令を読む
    await this.phase(0, `PC ＝ ${hex(info.pc)}。この番地の命令を命令メモリから読む`, u);
    this.lit(['pc', 'imem']);
    await this.move(this.path('pc-imem'), hex(info.pc), 'pc', u);
    this.pulse(this.blocks.get('imem'));
    this.lit(['imem', 'dec']);
    await this.move(this.path('imem-dec'), hex(ins.word).slice(2), 'rom', u);

    // ② 解読する
    await this.phase(1, `機械語 ${hex(ins.word)} を欄に分ける：${ins.text}`, u);
    this.lit(['dec']);
    this.drawDec(info);
    this.pulse(this.blocks.get('dec'));
    await this.clock!.wait(u * 0.5);

    const readRegs: number[] = [];
    if (def.syntax.includes('s') && ins.op !== 'syscall') readRegs.push(ins.rs);
    if (def.syntax.includes('t') && (def.format === 'R' || def.group === 'branch' || (def.group === 'mem' && ins.op.startsWith('s')))) readRegs.push(ins.rt);
    if (def.syntax.includes('m')) readRegs.splice(0, readRegs.length, ins.rs, ...(ins.op.startsWith('s') ? [ins.rt] : []));
    if (ins.op === 'syscall') readRegs.push(2, ...info.reads.filter((x) => x.reg !== 2).map((x) => x.reg));
    const uniq = [...new Set(readRegs)].filter((r) => r !== 0 || def.format === 'R');
    if (uniq.length) {
      this.lit(['dec', 'reg']);
      await Promise.all([this.move(this.path('dec-reg'), uniq.map(R).join(' '), 'alu', u * 0.8)]);
      uniq.forEach((r) => rowLit(r, 'rd'));
    }

    // ③ 計算する
    const isShift = ['sll', 'srl', 'sra'].includes(ins.op);
    if (ins.op === 'syscall') {
      await this.phase(2, `$v0 ＝ ${val(2)} なので、${info.syscall?.name ?? ''} を OS に頼む`, u);
      this.lit(['reg', 'io']);
      const first = `$v0=${val(2)}`;
      let back = Math.max(28, first.length * 7.4 + 14) + 8;
      const moves = [this.move(this.path('reg-io', 2), first, 'reg', u)];
      for (const r of info.reads) {
        if (r.reg === 2) continue;
        const lb = `${R(r.reg)}=${vs(r.value)}`;
        moves.push(this.move(this.path('reg-io', r.reg), lb, 'reg', u * 1.15, back));
        back += Math.max(28, lb.length * 7.4 + 14) + 8;
      }
      await Promise.all(moves);
      this.pulse(this.blocks.get('io'));
      this.ioText.textContent = lastOutputLine(m.output);
    } else if (def.group === 'jump' && (ins.op === 'j' || ins.op === 'jal')) {
      await this.phase(2, `${ins.op} は計算しない。飛び先の番地は命令の中に入っている`, u);
    } else if (ins.op === 'jr' || ins.op === 'jalr') {
      await this.phase(2, `${R(ins.rs)} に入っている番地へ飛ぶ`, u);
    } else if (ins.op === 'mfhi' || ins.op === 'mflo') {
      await this.phase(2, `${ins.op === 'mfhi' ? 'HI' : 'LO'} の値をそのまま使う`, u);
    } else if (info.alu) {
      const usesConst = (def.format === 'I' && def.group !== 'branch') || isShift;
      const label = def.group === 'branch' ? '比べる（引き算して 0 か）' : def.group === 'mem' ? '番地を計算する（足し算）' : '計算する';
      await this.phase(2, `${label}：${aluFormula(info)}`, u);
      this.lit(['reg', 'alu', ...(usesConst ? ['sel', 'dec'] : [])]);
      const moves: Promise<void>[] = [];
      if (ins.op === 'lui') {
        moves.push(this.move([...this.path('dec-const'), [SEL.x + SEL.w, 318], ALU_B], String(ins.imm), 'rom', u * 1.2));
      } else {
        const aReg = isShift ? ins.rt : ins.rs;
        moves.push(this.move(this.path('reg-a', aReg), vs(val(aReg)), 'reg', u));
        if (usesConst) {
          const cst = isShift ? ins.shamt : ins.imm;
          moves.push(this.move([...this.path('dec-const'), [SEL.x + SEL.w, 318], ALU_B], String(cst), 'rom', u * 1.2));
        } else {
          moves.push(this.move([...this.path('reg-b', ins.rt), [SEL.x + SEL.w, 318], ALU_B], vs(val(ins.rt)), 'reg', u * 1.1));
        }
      }
      await Promise.all(moves);
      this.pulse(this.blocks.get('alu'));
      this.aluSub.textContent = aluFormula(info);
      this.aluText.textContent = aluResultText(info);
      await this.clock!.wait(u * 0.5);
    }

    // ④ メモリ
    if (info.mem) {
      const mm = info.mem;
      await this.phase(3, mm.write ? `番地 ${hex(mm.addr)} に ${R(ins.rt)} の値を書く` : `番地 ${hex(mm.addr)} から読む`, u);
      const area = areaOf(mm.addr);
      this.lit(['alu', area, ...(mm.write ? ['reg'] : [])]);
      const moves = [this.move(this.path(`alu-mem-${area}`), hex(mm.addr), 'pc', u)];
      if (mm.write) moves.push(this.move(this.path(`reg-mem-${area}`, ins.rt), vs(mm.value), 'reg', u * 1.3));
      await Promise.all(moves);
      this.pulse(this.blocks.get(area));
      this.drawMem(m, b.regs.get(29)!.v, mm.addr);
      if (!mm.write) {
        this.lit([area, 'wb']);
        await this.move(this.path(`mem-wb-${area}`), vs(info.writes[0]?.value ?? mm.value), 'mem', u * 0.8);
      }
    }

    // ⑤ 書き込む
    const regWrites = info.writes.filter((w) => !(ins.op === 'jal' || ins.op === 'jalr') || w.reg !== 31);
    if (info.hiLo && this.hiRow && this.loRow) {
      await this.phase(4, `結果を HI と LO に書き込む`, u);
      this.lit(['alu', 'wb', 'reg']);
      await this.move(this.path('alu-wb'), '', 'alu', u * 0.5);
      await Promise.all([
        this.move(this.path('wb-row', -1).slice(0, 2).concat([[412, this.hiRow.y], [REG.x + 6, this.hiRow.y]]), `HI=${s32(info.hiLo.hi)}`, 'alu', u * 0.9),
        this.move(this.path('wb-row', -1).slice(0, 2).concat([[412, this.loRow.y], [REG.x + 6, this.loRow.y]]), `LO=${s32(info.hiLo.lo)}`, 'alu', u * 1.0),
      ]);
      this.hiRow.val.textContent = String(s32(info.hiLo.hi));
      this.loRow.val.textContent = String(s32(info.hiLo.lo));
      this.setV(this.hiRow, info.hiLo.hi);
      this.setV(this.loRow, info.hiLo.lo);
      this.hiRow.bg.classList.add('wr');
      this.loRow.bg.classList.add('wr');
    } else if (regWrites.length) {
      const w = regWrites[regWrites.length - 1];
      await this.phase(4, `結果 ${vs(w.value)} を ${R(w.reg)} に書き込む`, u);
      this.lit(['wb', 'reg']);
      if (ins.op === 'mfhi' || ins.op === 'mflo') {
        const src = ins.op === 'mfhi' ? this.hiRow : this.loRow;
        if (src) await this.move([[REG.x, src.y], [408, src.y], [408, this.rowY(w.reg)], [REG.x, this.rowY(w.reg)]], vs(w.value), 'alu', u);
      } else if (ins.op === 'syscall') {
        await this.move(this.path('io-wb'), vs(w.value), 'io', u * 0.6);
        await this.move(this.path('wb-row', w.reg), vs(w.value), 'io', u);
      } else {
        if (!info.mem) await this.move(this.path('alu-wb'), vs(w.value), 'alu', u * 0.8);
        await this.move(this.path('wb-row', w.reg), vs(w.value), info.mem ? 'mem' : 'alu', u);
      }
      const row = this.regRows.get(w.reg);
      if (row) {
        row.val.textContent = vs(w.value);
        row.val.classList.remove('uninit');
        row.bg.classList.add('wr');
        this.setV(row, w.value);
        this.pulse(row.bg);
      }
      if (w.reg === 29) this.drawMem(m, w.value, info.mem?.addr);
    }

    // ⑥ 次の命令へ
    const pc4 = info.pc + 4;
    let msg = `次は PC＋4 ＝ ${hex(pc4)}`;
    if (info.branch) msg = info.branch.taken ? `${info.branch.a === info.branch.b ? '等しい' : '等しくない'} → 飛ぶ：PC ＝ (PC＋4) ＋ ${info.branch.offset}×4 ＝ ${hex(info.branch.target)}` : `${info.branch.a === info.branch.b ? '等しい' : '等しくない'} → 飛ばない：PC ＝ PC＋4`;
    else if (info.jump) msg = `飛ぶ：PC ＝ ${hex(info.jump.target)}`;
    else if (info.halted) msg = 'exit：プログラムを終える';
    await this.phase(5, msg, u);
    if (info.halted) {
      this.lit([]);
      return;
    }
    this.lit(['pc', 'add4', 'mux']);
    await this.move(this.path('pc-add4'), hex(info.pc), 'pc', u * 0.5);
    this.pulse(this.blocks.get('add4'));
    const add4 = this.move(this.path('add4-mux'), hex(pc4), 'pc', u * 0.8);
    const others: Promise<void>[] = [add4];
    if (ins.op === 'jal' || ins.op === 'jalr') {
      others.push(this.move(this.path('add4-row', 31), `$ra=${hex(pc4)}`, 'pc', u * 1.1).then(() => {
        const row = this.regRows.get(31);
        if (row) {
          row.val.textContent = hex(pc4);
          row.val.classList.remove('uninit');
          this.setV(row, pc4);
          row.bg.classList.add('wr');
        }
      }));
    }
    if (info.branch) {
      this.lit(['pc', 'add4', 'mux', 'dec', 'alu']);
      others.push(this.move(this.path('dec-target'), hex(info.branch.target), 'rom', u * 0.9));
      others.push(this.move(this.path('alu-ctl'), info.branch.taken ? '飛ぶ' : '飛ばない', 'ctl', u * 0.9));
    } else if (ins.op === 'j' || ins.op === 'jal') {
      this.lit(['pc', 'add4', 'mux', 'dec']);
      others.push(this.move(this.path('dec-target'), hex(info.jump!.target), 'rom', u * 0.9));
    } else if (ins.op === 'jr' || ins.op === 'jalr') {
      this.lit(['pc', 'add4', 'mux', 'reg']);
      rowLit(ins.rs, 'rd');
      others.push(this.move([[REG.x + REG.w / 2, this.rowY(ins.rs) - 10], ...this.path('reg-mux').slice(0)], hex(info.jump!.target), 'reg', u * 1.1));
    }
    await Promise.all(others);
    this.pulse(this.blocks.get('mux'));
    await this.move(this.path('mux-pc'), hex(info.nextPc), info.nextPc !== pc4 ? 'ctl' : 'pc', u * 0.5);
    this.drawPc(info.nextPc);
    this.pulse(this.blocks.get('pc'));
    await this.clock!.wait(u * 0.3);
  }
}

function lastOutputLine(out: string): string {
  const lines = out.split('\n');
  const s = lines[lines.length - 1] || (lines.length > 1 ? lines[lines.length - 2] : '');
  return s.length > 20 ? '…' + s.slice(-19) : s;
}

const SYM: Record<string, string> = { '+': '+', '-': '−', AND: 'AND', OR: 'OR', XOR: 'XOR', NOR: 'NOR', '<': '<', '<u': '<', '<<': '<<', '>>>': '>>', '>>': '>>', '<<16': '<<', '×': '×', '÷': '÷' };

function aluFormula(info: ExecInfo): string {
  const a = info.alu!;
  const op = a.op;
  const sh = (v: number) => (v >= 0x00400000 && v < 0x80000000 && v > 0x00400000 ? hex(v) : String(op === '<u' ? v >>> 0 : s32(v)));
  if (op === '<<16') return `${a.a} << 16`;
  return `${sh(a.a)} ${SYM[op] ?? op} ${sh(a.b)}`;
}

function aluResultText(info: ExecInfo): string {
  const a = info.alu!;
  if (info.branch) return info.branch.a === info.branch.b ? '＝ 0（等しい）' : '≠ 0（等しくない）';
  if (a.op === '<' || a.op === '<u') return `→ ${a.result}`;
  const r = a.result;
  return '＝ ' + (r >= 0x00400000 && r < 0x80000000 && r > 0x00400000 ? hex(r) : String(s32(r)));
}

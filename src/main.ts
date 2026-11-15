import './style.css';
import { type Program, assemble } from './core/assembler';
import { explain, explainLine } from './core/explain';
import { type ExecInfo, Machine, RuntimeError, type StepResult } from './core/machine';
import { LESSON_TITLES, PRESETS } from './presets';
import { CPRESETS, type Stage } from './cpresets';
import type { SourceFile } from './compiler/pipeline';
import { CcView } from './ui/ccview';
import { Diagram } from './ui/diagram';
import { createEditor } from './ui/editor';
import { installValueTooltip } from './ui/tooltip';
import { type Base, type ViewState, esc, render } from './ui/render';

// ------------------------------------------------------------
// 設定（ブラウザに保存。保存できなくても動く）

interface Settings {
  base: Base;
  strict: boolean;
  font: 's' | 'm' | 'l';
  theme: 'auto' | 'light' | 'dark';
  speed: number;
}
const defaults: Settings = { base: 'dec', strict: true, font: 'm', theme: 'auto', speed: 1 };
function loadSettings(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('mipsviz.settings') ?? '{}') };
  } catch {
    return { ...defaults };
  }
}
function saveSettings() {
  try {
    localStorage.setItem('mipsviz.settings', JSON.stringify(settings));
  } catch {
    /* 保存できない環境 */
  }
}
const settings = loadSettings();

const SPEEDS = [
  { label: 'ゆっくり（1秒に1命令）', ms: 1000 },
  { label: 'ふつう（1秒に3命令）', ms: 333 },
  { label: '速い（1秒に10命令）', ms: 100 },
  { label: 'とても速い', ms: 20 },
  { label: '最速（結果だけ）', ms: 0 },
];

// ------------------------------------------------------------
// 状態

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
let mode: 1 | 2 | 3 = 1;
let prog: Program | null = null;
let m: Machine | null = null;
let dirty = true;
let last: ExecInfo[] = [];
let counts = new Map<number, number>();
let status = '「1ステップ」を押すと、1 命令ずつ実行します。';
let statusKind: ViewState['statusKind'] = 'info';
let errorLine: number | null = null;
let runTimer: number | null = null;
let waitingInput = false;
let currentPreset: string | null = null;
let ccOn = false; // モード④（C から機械語へ）を表示中
let fromC = false; // エディターのプログラムが C から作ったもの

const editor = createEditor($('#editor'), '', () => {
  dirty = true;
  if (runTimer !== null) stopRun();
  if (m) {
    status = 'プログラムが変わりました。次に実行するときは最初からになります。';
    statusKind = 'info';
    hideInput();
    refresh(false);
  }
  saveDraft();
});

const diagram = new Diagram($('#diagram-card'));
installValueTooltip();
const cc = new CcView($('#cc-view'), {
  run: (source, n) => loadCompiled(source, n),
  toast: (msg) => toast(msg),
  changed: () => {},
});

/** C から作ったアセンブリをエディターに入れて動かす */
function loadCompiled(source: string, n: 1 | 2 | 3) {
  stopRun();
  editor.setDoc(source);
  currentPreset = null;
  $<HTMLSelectElement>('#preset').value = '';
  $('#preset-note').textContent = 'C から作ったプログラム（④ C から機械語へ に戻ると C を直せます）';
  fromC = true;
  setMode(n, false);
  prepare();
  toast('C から作った実行ファイルを読みこみました。「1ステップ」で動かします。');
}

function saveDraft() {
  try {
    localStorage.setItem('mipsviz.draft', JSON.stringify({ preset: currentPreset, source: editor.getDoc() }));
  } catch {
    /* 保存できない環境 */
  }
}

// ------------------------------------------------------------
// 準備・実行

function prepare(): boolean {
  diagram.skip();
  stopRun();
  hideInput();
  prog = assemble(editor.getDoc());
  counts = new Map();
  last = [];
  errorLine = null;
  dirty = false;
  if (prog.errors.length) {
    m = null;
    status = prog.errors.map((e) => e.message).join('\n');
    statusKind = 'error';
    errorLine = prog.errors[0].line;
    refresh();
    return false;
  }
  // C から作ったプログラムは、退避のために値を入れていない $s をスタックに書くので、止めない
  m = new Machine(prog, { strictUninit: settings.strict && !fromC });
  status = '準備ができました。「1ステップ」で 1 命令ずつ、「実行」で続けて実行します。';
  statusKind = 'info';
  refresh();
  return true;
}

function ensureReady(): boolean {
  if (dirty || !m) return prepare();
  return true;
}

/** 1ステップ（モード①はソースの1行分、モード②は本当の命令1つ） */
function stepGroup(): StepResult & { infos: ExecInfo[] } {
  const infos: ExecInfo[] = [];
  let r: StepResult;
  for (;;) {
    r = m!.step();
    if (r.status === 'ok' || r.status === 'halted') {
      infos.push(r.info!);
      if (r.info!.instr.part === 0) counts.set(r.info!.instr.line, (counts.get(r.info!.instr.line) ?? 0) + 1);
    }
    if (r.status !== 'ok') break;
    if (mode !== 1) break;
    const next = m!.currentInstr();
    if (!next || next.part === 0) break;
  }
  return { ...r, infos };
}

function afterStep(r: StepResult & { infos: ExecInfo[] }): boolean {
  if (r.infos.length) {
    last = r.infos;
  }
  errorLine = null;
  switch (r.status) {
    case 'ok':
      status = '';
      statusKind = 'info';
      break;
    case 'halted':
      status = `プログラムが終わりました（${m!.steps} 命令を実行）。「最初から」でもう一度実行できます。`;
      statusKind = 'ok';
      break;
    case 'input':
      status = { int: '整数の入力を待っています（下のコンソールに入力して Enter）', string: '文字列の入力を待っています（下のコンソールに入力して Enter）', char: '1 文字の入力を待っています（下のコンソールに入力して Enter）' }[r.inputKind!];
      statusKind = 'wait';
      resumeAfterInput = running;
      showInput();
      break;
    case 'error':
      status = `${r.error!.line}行目：${r.error!.message}`;
      statusKind = 'error';
      errorLine = r.error!.line;
      break;
  }
  refresh();
  return r.status === 'ok';
}

/** モード③のアニメーションの速さ（1 で約 3 秒。0 は動かさない） */
function animSpeed(forStep: boolean): number {
  const table = [1.5, 0.8, 0.4, 0, 0];
  const v = table[settings.speed];
  return forStep && v === 0 ? 0.4 : v;
}

/** モード③で、直前の命令の動きを見せる */
async function animateLast(forStep: boolean): Promise<void> {
  if (mode !== 3 || !m || !last.length) return;
  const sp = animSpeed(forStep);
  if (sp <= 0) return;
  for (const info of last) await diagram.animate(m, info, sp);
}

async function step() {
  if (diagram.animating) {
    diagram.skip(); // 動いている途中なら、すぐに終わらせて次へ
    await Promise.resolve();
  }
  if (!ensureReady()) return;
  if (m!.halted) return;
  afterStep(stepGroup());
  await animateLast(true);
}

function back() {
  if (!m || dirty) return;
  diagram.skip();
  stopRun();
  hideInput();
  const undoOne = () => {
    const info = m!.back();
    if (info && info.instr.part === 0) {
      const n = (counts.get(info.instr.line) ?? 1) - 1;
      if (n > 0) counts.set(info.instr.line, n);
      else counts.delete(info.instr.line);
    }
    return info;
  };
  let info = undoOne();
  if (!info) return;
  if (mode === 1) while (m.currentInstr() && m.currentInstr()!.part > 0 && (info = undoOne()));
  // ひとつ前に実行したもの（説明の欄に出す）
  last = [];
  const h = m.history;
  for (let k = h.length - 1; k >= 0; k--) {
    last.unshift(h[k].info);
    if (mode !== 1 || h[k].info.instr.part === 0) break;
  }
  status = '1 ステップ戻りました。';
  statusKind = 'info';
  errorLine = null;
  refresh();
}

function run() {
  if (runTimer !== null || running) {
    diagram.skip();
    stopRun();
    refresh();
    return;
  }
  if (!ensureReady() || m!.halted) return;
  const bps = editor.breakpoints();
  const ms = SPEEDS[settings.speed].ms;
  running = true;
  let first = true;
  const hitBreak = () => {
    const next = m!.currentInstr();
    return !first && next && next.part === 0 && bps.has(next.line);
  };
  if (ms === 0) {
    // 最速：まとめて実行して、最後だけ表示する
    let r: ReturnType<typeof stepGroup> | null = null;
    for (let k = 0; k < 100000; k++) {
      if (hitBreak()) break;
      r = stepGroup();
      first = false;
      if (r.status !== 'ok') break;
    }
    if (r && r.status === 'ok' && !hitBreak()) {
      running = false;
      afterStep({ status: 'error', error: new RuntimeError(m!.currentInstr()?.line ?? 1, '100,000 命令を実行しても終わりません。くり返しが終わっていない可能性があります'), infos: r.infos });
      return;
    }
    running = false;
    if (r) {
      running = r.status === 'input'; // 入力待ちなら、afterStep で「入力のあとで続ける」にする
      const ok = afterStep(r);
      running = false;
      if (ok) {
        status = 'ブレークポイントで止まりました。';
        refresh();
      }
    }
    return;
  }
  $('#btn-run').textContent = '⏸ 止める';
  $('#btn-run').classList.add('running');
  const tick = async () => {
    if (hitBreak()) {
      stopRun();
      status = 'ブレークポイントで止まりました。';
      refresh();
      return;
    }
    first = false;
    const ok = afterStep(stepGroup());
    const animated = mode === 3 && animSpeed(false) > 0;
    if (animated) await animateLast(false);
    if (!running) return; // 動きの途中で「止める」を押した
    if (!ok) {
      stopRun();
      if (waitingInput) return; // 入力のあとで続ける
      refresh();
      return;
    }
    runTimer = window.setTimeout(tick, animated ? 150 : ms);
  };
  runTimer = window.setTimeout(tick, 0);
}

let resumeAfterInput = false;
let running = false; // 「実行」で続けて実行している途中か（入力待ちのあとで続けるため）
function stopRun() {
  if (runTimer !== null) clearTimeout(runTimer);
  runTimer = null;
  running = false;
  $('#btn-run').textContent = '▶ 実行';
  $('#btn-run').classList.remove('running');
}

// ------------------------------------------------------------
// 入力（read_int など）

function showInput() {
  waitingInput = true;
  const box = $<HTMLFormElement>('#input-form');
  box.hidden = false;
  $<HTMLInputElement>('#input').focus();
}
function hideInput() {
  waitingInput = false;
  $<HTMLFormElement>('#input-form').hidden = true;
}
$<HTMLFormElement>('#input-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $<HTMLInputElement>('#input');
  if (!m) return;
  m.provideInput(inp.value);
  inp.value = '';
  hideInput();
  const resume = resumeAfterInput;
  resumeAfterInput = false;
  afterStep(stepGroup());
  if (resume && !m.halted && statusKind !== 'error') run();
});

// ------------------------------------------------------------
// 描画

function refresh(scroll = true) {
  const view = $('#view-main');
  const scrollTops = [...view.querySelectorAll('.scroll')].map((el) => el.scrollTop);
  if (m) {
    const lastIns = last[0];
    const spBefore = lastIns ? (lastIns.reads.find((x) => x.reg === 29)?.value ?? m.regs[29]) : undefined;
    const expl = last.length ? (mode === 1 ? explainLine(last, m.prog, spBefore) : explain(last[last.length - 1], m.prog, spBefore)) : undefined;
    const st: ViewState = { m, mode, base: mode === 1 ? 'dec' : settings.base, last, expl, status, statusKind };
    view.innerHTML = render(st);
    if (mode === 3) diagram.show(m, last.at(-1));
  } else {
    view.innerHTML = `<section class="card card-expl"><div class="status status-${statusKind}" role="status">${esc(status).replace(/\n/g, '<br>')}</div>
      ${statusKind === 'error' ? '' : '<p class="muted">左にプログラムを書くか、上の「プログラムを選ぶ」から授業のプログラムを開きます。</p>'}</section>`;
  }
  [...view.querySelectorAll('.scroll')].forEach((el, i) => {
    el.scrollTop = scrollTops[i] ?? 0;
  });
  // 命令メモリは PC の行が見えるようにする
  const pcRow = view.querySelector<HTMLElement>('#textmem tr.pc');
  if (pcRow) {
    const box = pcRow.closest('.scroll') as HTMLElement;
    const top = pcRow.offsetTop - box.clientHeight / 2;
    if (pcRow.offsetTop < box.scrollTop + 30 || pcRow.offsetTop > box.scrollTop + box.clientHeight - 30) box.scrollTop = top;
  }
  // エディター
  const marks: { line: number; kind: 'current' | 'error' | 'done' }[] = [];
  const cur = m && !m.halted && !dirty ? m.currentInstr() : undefined;
  if (cur) marks.push({ line: cur.line, kind: 'current' });
  if (errorLine) marks.push({ line: errorLine, kind: 'error' });
  editor.setMarks(marks, scroll ? (errorLine ?? cur?.line) : undefined);
  editor.setCounts(dirty ? new Map() : counts);
  // コンソール
  const out = m ? m.output : '';
  $('#console-out').textContent = out || '';
  $('#console-out').classList.toggle('empty', !out);
  // ボタン
  $<HTMLButtonElement>('#btn-back').disabled = !m || dirty || !m.canBack;
  $<HTMLButtonElement>('#btn-step').disabled = !!m && !dirty && m.halted;
  $<HTMLButtonElement>('#btn-run').disabled = !!m && !dirty && m.halted && runTimer === null;
}

// ------------------------------------------------------------
// プリセット・URL

function fillPresets() {
  const sel = $<HTMLSelectElement>('#preset');
  const groups = new Map<string, typeof PRESETS>();
  for (const p of PRESETS) groups.set(p.lesson, [...(groups.get(p.lesson) ?? []), p]);
  sel.innerHTML =
    '<option value="">プログラムを選ぶ…</option>' +
    [...groups.entries()]
      .map(([l, ps]) => `<optgroup label="${esc(LESSON_TITLES[l] ?? `第${l}回`)}">${ps.map((p) => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}</optgroup>`)
      .join('');
}

function openPreset(id: string, opts: { mode?: number; step?: number } = {}) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return false;
  currentPreset = id;
  fromC = false;
  $<HTMLSelectElement>('#preset').value = id;
  editor.setDoc(p.source);
  setMode((opts.mode === 1 || opts.mode === 2 || opts.mode === 3 ? opts.mode : p.mode) as 1 | 2 | 3, false);
  $('#preset-note').textContent = [p.note, p.template ? '課題のひな形です。完成させてから実行します。' : ''].filter(Boolean).join('　');
  prepare();
  if (opts.step) {
    for (let k = 0; k < opts.step && m && !m.halted; k++) {
      const r = stepGroup();
      last = r.infos;
      if (r.status !== 'ok') {
        afterStep(r);
        return true;
      }
    }
    afterStep({ status: 'ok', infos: last });
  }
  return true;
}

async function compress(s: string): Promise<string> {
  const cs = new Blob([s]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = new Uint8Array(await new Response(cs).arrayBuffer());
  let bin = '';
  buf.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function decompress(s: string): Promise<string> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(ds).text();
}

async function share() {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  if (ccOn) {
    const st = cc.shareState();
    if (st.preset) url.searchParams.set('cpreset', st.preset);
    else url.hash = 'cfiles=' + (await compress(JSON.stringify(st.files)));
    url.searchParams.set('mode', '4');
    url.searchParams.set('stage', st.stage);
    try {
      await navigator.clipboard.writeText(url.toString());
      toast('リンクをコピーしました。このリンクを開くと、同じ C のプログラムが開きます。');
    } catch {
      prompt('このリンクをコピーしてください', url.toString());
    }
    return;
  }
  const p = PRESETS.find((x) => x.id === currentPreset);
  const doc = editor.getDoc();
  if (p && p.source === doc) {
    url.searchParams.set('preset', p.id);
  } else {
    url.hash = 'code=' + (await compress(doc));
  }
  url.searchParams.set('mode', String(mode));
  try {
    await navigator.clipboard.writeText(url.toString());
    toast('リンクをコピーしました。このリンクを開くと、同じプログラムが開きます。');
  } catch {
    prompt('このリンクをコピーしてください', url.toString());
  }
}

let toastTimer = 0;
function toast(msg: string) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 3500);
}

// ------------------------------------------------------------
// モード・設定

function setMode(n: 1 | 2 | 3 | 4, re = true) {
  diagram.skip();
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.mode) === n)));
  ccOn = n === 4;
  $('#cc-view').hidden = !ccOn;
  if (n === 4) {
    stopRun();
    document.body.dataset.mode = '4';
    cc.shown();
    return;
  }
  mode = n;
  $('#base-wrap').hidden = n !== 2;
  $('#diagram-card').hidden = n !== 3;
  document.body.dataset.mode = String(n);
  if (re) {
    // 戻るときにモード①の区切りに合わせるため、そのまま表示だけ変える
    refresh(false);
  }
}

function applySettings() {
  document.documentElement.dataset.font = settings.font;
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  $<HTMLSelectElement>('#base').value = settings.base;
  $<HTMLSelectElement>('#font').value = settings.font;
  $<HTMLSelectElement>('#theme').value = settings.theme;
  $<HTMLInputElement>('#strict').checked = settings.strict;
  $<HTMLSelectElement>('#speed').value = String(settings.speed);
}

function bind() {
  $('#btn-step').addEventListener('click', step);
  $('#btn-back').addEventListener('click', back);
  $('#btn-run').addEventListener('click', run);
  $('#btn-reset').addEventListener('click', () => prepare());
  $('#btn-share').addEventListener('click', share);
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(Number(b.dataset.mode) as 1 | 2 | 3 | 4)));
  $<HTMLSelectElement>('#preset').addEventListener('change', (e) => {
    const id = (e.target as HTMLSelectElement).value;
    if (id) openPreset(id);
  });
  const speed = $<HTMLSelectElement>('#speed');
  speed.innerHTML = SPEEDS.map((s, i) => `<option value="${i}">${s.label}</option>`).join('');
  speed.addEventListener('change', () => {
    settings.speed = Number(speed.value);
    saveSettings();
  });
  $<HTMLSelectElement>('#base').addEventListener('change', (e) => {
    settings.base = (e.target as HTMLSelectElement).value as Base;
    saveSettings();
    refresh(false);
  });
  $<HTMLSelectElement>('#font').addEventListener('change', (e) => {
    settings.font = (e.target as HTMLSelectElement).value as Settings['font'];
    saveSettings();
    applySettings();
  });
  $<HTMLSelectElement>('#theme').addEventListener('change', (e) => {
    settings.theme = (e.target as HTMLSelectElement).value as Settings['theme'];
    saveSettings();
    applySettings();
  });
  $<HTMLInputElement>('#strict').addEventListener('change', (e) => {
    settings.strict = (e.target as HTMLInputElement).checked;
    saveSettings();
    dirty = true;
    status = '設定を変えました。次に実行するときは最初からになります。';
    refresh(false);
  });
  document.addEventListener('keydown', (e) => {
    if (ccOn) return;
    if (e.key === 'F8' && !e.shiftKey) {
      e.preventDefault();
      step();
    } else if (e.key === 'F8' && e.shiftKey) {
      e.preventDefault();
      back();
    } else if (e.key === 'F5') {
      e.preventDefault();
      run();
    }
  });
}

async function init() {
  fillPresets();
  bind();
  applySettings();
  await initAsm();
  // モード④（C）のリンク
  const q = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.slice(1));
  const stage = (q.get('stage') ?? undefined) as Stage | undefined;
  if (hash.get('cfiles')) {
    try {
      cc.loadFiles(JSON.parse(await decompress(hash.get('cfiles')!)) as SourceFile[], stage);
      setMode(4);
    } catch {
      toast('リンクの C のプログラムを読めませんでした。');
    }
  } else if (q.get('cpreset') && CPRESETS.some((p) => p.id === q.get('cpreset'))) {
    cc.openPreset(q.get('cpreset')!, stage);
    setMode(4);
  } else if (q.get('mode') === '4') setMode(4);
}

async function initAsm() {
  const q = new URLSearchParams(location.search);
  const qMode = Number(q.get('mode')) || undefined;
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('code')) {
    try {
      editor.setDoc(await decompress(hash.get('code')!));
      setMode(qMode === 2 || qMode === 3 ? qMode : 1, false);
      prepare();
      return;
    } catch {
      toast('リンクのプログラムを読めませんでした。');
    }
  }
  if (q.get('preset') && openPreset(q.get('preset')!, { mode: qMode, step: Number(q.get('step')) || 0 })) return;
  try {
    const d = JSON.parse(localStorage.getItem('mipsviz.draft') ?? 'null');
    if (d?.source) {
      currentPreset = d.preset ?? null;
      if (currentPreset) $<HTMLSelectElement>('#preset').value = currentPreset;
      editor.setDoc(d.source);
      setMode(qMode === 2 || qMode === 3 ? qMode : 1, false);
      prepare();
      return;
    }
  } catch {
    /* 保存できない環境 */
  }
  openPreset('05-arith', { mode: qMode });
}

init();

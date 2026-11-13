// 画面の右側（モード①・②）の描画
import type { DataLabel, Instr, Program } from '../core/assembler';
import { OPS, REG_NAMES, REG_ROLE, STACK_TOP, hex, s32 } from '../core/defs';
import { type Explanation, nameAddr, readable } from '../core/explain';
import type { ExecInfo, Machine } from '../core/machine';

export type Base = 'dec' | 'hex' | 'bin';

export interface ViewState {
  m: Machine;
  mode: 1 | 2 | 3;
  base: Base;
  last: ExecInfo[]; // 直前に実行した命令（モード①では1行分）
  expl?: Explanation;
  status: string; // 状態の文（実行前・終了・エラーなど）
  statusKind: 'info' | 'ok' | 'error' | 'wait';
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function fmt(v: number, base: Base): string {
  if (base === 'hex') return hex(v);
  if (base === 'bin') return (v >>> 0).toString(2).padStart(32, '0').replace(/(.{4})(?=.)/g, '$1 ');
  return String(s32(v));
}

const R = (i: number) => '$' + REG_NAMES[i];

function groupOf(op: string): string {
  return OPS[op]?.group ?? 'sys';
}

/** プログラムで使っているレジスタ（モード①で表示する） */
export function usedRegs(prog: Program): number[] {
  const set = new Set<number>();
  for (const ins of prog.text) {
    const re = /\$(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ins.source))) {
      const i = REG_NAMES.indexOf(m[1] as never);
      const n = /^\d+$/.test(m[1]) ? Number(m[1]) : i;
      if (n > 0) set.add(n);
    }
    if (ins.op === 'syscall') set.add(2).add(4);
    if (ins.op === 'jal' || ins.op === 'jalr') set.add(31);
  }
  set.delete(1);
  return [...set].sort((a, b) => a - b);
}

function touched(st: ViewState) {
  const reads = new Set<number>();
  const writes = new Set<number>();
  const memAddrs = new Map<number, 'r' | 'w'>();
  for (const i of st.last) {
    i.reads.forEach((r) => reads.add(r.reg));
    i.writes.forEach((w) => writes.add(w.reg));
    if (i.mem) for (let k = 0; k < i.mem.size; k++) memAddrs.set(i.mem.addr + k, i.mem.write ? 'w' : 'r');
  }
  reads.delete(1);
  writes.delete(1);
  return { reads, writes, memAddrs };
}

function explCard(st: ViewState): string {
  const last = st.last.at(-1);
  const next = st.m.currentInstr();
  const lastIns = st.last[0]?.instr;
  let html = `<div class="status status-${st.statusKind}" role="status">${esc(st.status)}</div>`;
  if (lastIns && st.expl) {
    html += `<div class="expl">
      <div class="expl-head"><span class="tag">いま実行した</span><code class="g-${groupOf(lastIns.op)}">${esc(st.mode === 1 ? lastIns.source : last!.instr.text)}</code>
      ${st.mode === 1 ? `<span class="readable">${esc(readable(lastIns))}</span>` : lastIns.pseudo ? `<span class="readable">${esc(lastIns.source)} の ${last!.instr.part + 1}/${lastIns.parts} 命令目</span>` : ''}</div>
      <p class="expl-sum">${esc(st.expl.summary)}</p>
      ${st.expl.details.length ? `<ul class="expl-det">${st.expl.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
    </div>`;
  }
  if (next && !st.m.halted) {
    const text = st.mode === 1 ? next.source : next.text;
    html += `<div class="next"><span class="tag tag-next">次に実行する</span><code>${esc(text)}</code>${st.mode === 1 ? `<span class="readable">${esc(readable(next))}</span>` : ''}</div>`;
  }
  return `<section class="card card-expl" aria-label="説明">${html}</section>`;
}

// ------------------------------------------------------------
// モード①

function regBoxes(st: ViewState, regs: number[], base: Base): string {
  const { reads, writes } = touched(st);
  const m = st.m;
  return regs
    .map((i) => {
      const cls = writes.has(i) ? 'w' : reads.has(i) ? 'r' : '';
      // 番地が入っているレジスタ（$sp・$ra や la で入れたもの）は 16進数で出す
      const isAddr = [28, 29, 30, 31].includes(i) || (m.regs[i] >= 0x00400000 && m.regs[i] < 0x80000000 && (m.regs[i] & 3) === 0 && m.regs[i] > 0x00400000);
      const v = m.init[i] ? (isAddr && base === 'dec' ? hex(m.regs[i]) : fmt(m.regs[i], base)) : '？';
      return `<div class="reg ${cls} ${m.init[i] ? '' : 'uninit'}" title="${esc(REG_ROLE[REG_NAMES[i]] ?? '')}">
        <div class="reg-name">${R(i)}</div><div class="reg-val ${isAddr && m.init[i] ? 'addr' : ''}">${esc(v)}</div><div class="reg-role">${esc(REG_ROLE[REG_NAMES[i]] ?? '')}${isAddr && m.init[i] && ![28, 29, 30, 31].includes(i) ? '（番地）' : ''}</div></div>`;
    })
    .join('');
}

function dataVar(st: ViewState, d: DataLabel, memAddrs: Map<number, 'r' | 'w'>): string {
  const m = st.m;
  const cells: string[] = [];
  if (d.kind === 'word' || d.kind === 'half') {
    const unit = d.kind === 'word' ? 4 : 2;
    for (let k = 0; k < d.count; k++) {
      const a = d.addr + k * unit;
      let v = 0;
      for (let b = unit - 1; b >= 0; b--) v = v * 256 + m.readByte(a + b);
      const sv = unit === 4 ? s32(v) : (v << 16) >> 16;
      const acc = memAddrs.get(a) ?? '';
      cells.push(`<div class="cell ${acc}"><div class="cell-i">[${k}]</div><div class="cell-v">${sv}</div></div>`);
    }
  } else {
    const n = d.kind === 'asciiz' ? d.count + 1 : d.size;
    for (let k = 0; k < Math.min(n, 64); k++) {
      const a = d.addr + k;
      const b = m.readByte(a);
      const acc = memAddrs.get(a) ?? '';
      const ch = b === 0 ? '\\0' : b === 10 ? '\\n' : b >= 32 && b < 127 ? String.fromCharCode(b) : String(b);
      cells.push(`<div class="cell byte ${acc} ${b === 0 ? 'nul' : ''}"><div class="cell-i">${k}</div><div class="cell-v">${esc(ch)}</div></div>`);
    }
  }
  const kind = { word: '.word（1つ 4 バイト）', half: '.half（1つ 2 バイト）', byte: '.byte', ascii: '.ascii（1文字 1 バイト）', asciiz: '.asciiz（1文字 1 バイト＋最後に 0）', space: '.space' }[d.kind];
  return `<div class="var"><div class="var-head"><b>${esc(d.name)}</b><span>${kind}・${d.size} バイト・番地 ${hex(d.addr)}</span></div><div class="cells">${cells.join('')}</div></div>`;
}

/** スタックの行（sw で退避したレジスタの名前を付ける） */
function stackRows(st: ViewState) {
  const m = st.m;
  const sp = m.regs[29];
  const saved = new Map<number, string>();
  for (const h of m.history) {
    const mm = h.info.mem;
    if (mm && mm.write && mm.addr >= 0x7f000000) saved.set(mm.addr, R(h.info.instr.rt));
  }
  let low = sp;
  for (const a of saved.keys()) low = Math.min(low, a);
  const rows: { addr: number; value: number; inUse: boolean; isSp: boolean; saved?: string }[] = [];
  if (low >= STACK_TOP && saved.size === 0) return { rows, sp };
  for (let a = STACK_TOP; a >= low - 8 && rows.length < 24; a -= 4) {
    rows.push({ addr: a, value: m.readWord(a), inUse: a >= sp && a < STACK_TOP, isSp: a === sp, saved: saved.get(a) });
  }
  return { rows, sp };
}

function stackView(st: ViewState, base: Base): string {
  const { rows, sp } = stackRows(st);
  const { memAddrs } = touched(st);
  const used = (STACK_TOP - sp) | 0;
  const head = `<h3>スタック <small>$sp ＝ ${hex(sp)}${used > 0 ? `（最初より ${used} バイト ＝ ${used / 4} ワード下）` : '（最初の位置）'}</small></h3>`;
  if (!rows.length) return `<section class="card">${head}<p class="muted">まだ使っていません。<code>addi $sp, $sp, -4</code> で場所をとると、ここに表示します。</p></section>`;
  const body = rows
    .map((r) => {
      const acc = memAddrs.get(r.addr) ?? '';
      return `<tr class="${r.inUse ? 'inuse' : 'free'} ${acc}">
        <td class="mono">${hex(r.addr)}</td>
        <td class="mono">${r.inUse || r.saved ? esc(r.saved === '$ra' || r.saved === '$fp' ? hex(r.value) : fmt(r.value, base)) : ''}</td>
        <td>${r.saved && r.inUse ? `${esc(r.saved)} を退避` : ''}</td>
        <td class="sp">${r.isSp ? '← $sp' : r.addr === STACK_TOP ? '最初の $sp' : ''}</td></tr>`;
    })
    .join('');
  return `<section class="card">${head}
    <p class="muted small">上ほど番地が大きい。場所をとるときは $sp を<b>減らす</b>（下へ伸びる）。1 行 ＝ 1 ワード ＝ 4 バイト</p>
    <table class="stack"><thead><tr><th>番地</th><th>値</th><th></th><th></th></tr></thead><tbody>${body}</tbody></table></section>`;
}

function mode1(st: ViewState): string {
  const { memAddrs } = touched(st);
  const regs = usedRegs(st.m.prog);
  const vars = st.m.prog.dataLabels.filter((d) => d.size > 0);
  return `${explCard(st)}
  <section class="card"><h3>レジスタ <small>（このプログラムで使うもの。？ はまだ値が入っていない）</small></h3>
    <div class="regs">${regBoxes(st, regs, 'dec')}</div>
    <p class="legend"><span class="lg lg-r"></span>読んだ <span class="lg lg-w"></span>書いた</p></section>
  ${vars.length ? `<section class="card"><h3>メモリ（データ）</h3>${vars.map((d) => dataVar(st, d, memAddrs)).join('')}</section>` : ''}
  ${usesStack(st.m.prog) ? stackView(st, 'dec') : ''}`;
}

function usesStack(prog: Program): boolean {
  return prog.text.some((i) => i.rs === 29 || i.rt === 29 || i.rd === 29);
}

// ------------------------------------------------------------
// モード②

function fieldsView(ins: Instr): string {
  const def = OPS[ins.op];
  const w = ins.word >>> 0;
  const bits = (hi: number, lo: number) => ((w >>> lo) & ((1 << (hi - lo + 1)) - 1)).toString(2).padStart(hi - lo + 1, '0');
  type F = { name: string; hi: number; lo: number; cls: string; mean: string };
  let fs: F[];
  if (def.format === 'R') {
    fs = [
      { name: 'op', hi: 31, lo: 26, cls: 'f-op', mean: String(def.opcode) },
      { name: 'rs', hi: 25, lo: 21, cls: 'f-rs', mean: R(ins.rs) },
      { name: 'rt', hi: 20, lo: 16, cls: 'f-rs', mean: R(ins.rt) },
      { name: 'rd', hi: 15, lo: 11, cls: 'f-rd', mean: R(ins.rd) },
      { name: 'shamt', hi: 10, lo: 6, cls: 'f-sh', mean: String(ins.shamt) },
      { name: 'funct', hi: 5, lo: 0, cls: 'f-op', mean: String(def.funct) },
    ];
  } else if (def.format === 'I') {
    fs = [
      { name: 'op', hi: 31, lo: 26, cls: 'f-op', mean: String(def.opcode) },
      { name: 'rs', hi: 25, lo: 21, cls: 'f-rs', mean: R(ins.rs) },
      { name: 'rt', hi: 20, lo: 16, cls: 'f-rd', mean: R(ins.rt) },
      { name: def.group === 'branch' ? '飛ぶ命令の数' : def.group === 'mem' ? '番地のずれ' : '定数', hi: 15, lo: 0, cls: 'f-imm', mean: String(ins.imm) },
    ];
  } else {
    fs = [
      { name: 'op', hi: 31, lo: 26, cls: 'f-op', mean: String(def.opcode) },
      { name: '飛び先の番地 ÷ 4', hi: 25, lo: 0, cls: 'f-addr', mean: `${hex(ins.target)} ÷ 4` },
    ];
  }
  const cells = fs
    .map((f) => `<div class="field ${f.cls}" style="flex:${f.hi - f.lo + 1}"><div class="f-name">${esc(f.name)}</div><div class="f-bits mono">${bits(f.hi, f.lo)}</div><div class="f-mean">${esc(f.mean)}</div></div>`)
    .join('');
  return `<div class="fields-head"><code class="g-${def.group}">${esc(ins.text)}</code><span class="muted">${def.format} 形式</span><span class="mono">${hex(w)}</span></div><div class="fields">${cells}</div>`;
}

function textMemory(st: ViewState): string {
  const m = st.m;
  const lastAddrs = new Set(st.last.map((i) => i.pc));
  const branchTarget = st.last.at(-1)?.branch?.target ?? st.last.at(-1)?.jump?.target;
  const rows = m.prog.text
    .map((ins) => {
      const labels = m.prog.textLabels.get(ins.addr);
      const cls = [ins.addr === m.pc && !m.halted ? 'pc' : '', lastAddrs.has(ins.addr) ? 'last' : '', ins.addr === branchTarget ? 'target' : ''].join(' ');
      return `<tr class="${cls}" data-addr="${ins.addr}">
        <td class="mono">${ins.addr === m.pc && !m.halted ? '<span class="pc-arrow">PC→</span>' : ''}${hex(ins.addr)}</td>
        <td class="mono">${hex(ins.word).slice(2)}</td>
        <td>${labels ? `<span class="lbl">${esc(labels.join(', '))}:</span> ` : ''}<code class="g-${groupOf(ins.op)}">${esc(ins.text)}</code></td>
        <td class="src">${ins.part === 0 && ins.pseudo ? esc(ins.source) : ins.part > 0 ? '〃' : ''}</td></tr>`;
    })
    .join('');
  return `<section class="card"><h3>命令メモリ <small>（1 命令 ＝ 4 バイト。番地は 4 ずつ増える）</small></h3>
    <div class="scroll" id="textmem"><table class="textmem"><thead><tr><th>番地</th><th>機械語</th><th>命令</th><th>元の書き方</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function regGrid(st: ViewState): string {
  const { reads, writes } = touched(st);
  const m = st.m;
  const cells = REG_NAMES.map((n, i) => {
    const cls = writes.has(i) ? 'w' : reads.has(i) ? 'r' : '';
    return `<div class="rg ${cls} ${m.init[i] ? '' : 'uninit'}" title="${esc(REG_ROLE[n] ?? '')}"><span class="rg-n">$${n}<small>${i}</small></span><span class="rg-v mono">${m.init[i] ? esc(fmt(m.regs[i], st.base === 'dec' && i >= 28 ? 'hex' : st.base)) : '—'}</span></div>`;
  }).join('');
  const hl = (name: string, v: number) => `<div class="rg ${m.hiLoInit ? '' : 'uninit'} ${st.last.some((i) => i.hiLo) ? 'w' : ''}"><span class="rg-n">${name}</span><span class="rg-v mono">${m.hiLoInit ? esc(fmt(v, st.base)) : '—'}</span></div>`;
  return `<section class="card"><h3>レジスタ</h3><div class="reggrid ${st.base === 'bin' ? 'bin' : ''}">${cells}${hl('HI', m.hi)}${hl('LO', m.lo)}</div>
    <p class="legend"><span class="lg lg-r"></span>読んだ <span class="lg lg-w"></span>書いた　— はまだ値が入っていない</p></section>`;
}

function dataMemory(st: ViewState): string {
  const m = st.m;
  const { memAddrs } = touched(st);
  const size = m.prog.data.length;
  if (!size) return '';
  const base0 = 0x10010000;
  const rows: string[] = [];
  const labelAt = new Map<number, string[]>();
  for (const d of m.prog.dataLabels) {
    const a = d.addr & ~3;
    labelAt.set(a, [...(labelAt.get(a) ?? []), d.name]);
  }
  for (let a = base0; a < base0 + size && rows.length < 64; a += 4) {
    const bytes = [0, 1, 2, 3].map((k) => {
      const b = m.readByte(a + k);
      const acc = memAddrs.get(a + k) ?? '';
      const ch = b >= 32 && b < 127 ? String.fromCharCode(b) : b === 0 ? '\\0' : '·';
      return `<td class="byte ${acc}"><span class="mono">${b.toString(16).padStart(2, '0')}</span><small>${esc(ch)}</small></td>`;
    });
    const names = (labelAt.get(a) ?? []).join(', ');
    const nm = nameAddr(m.prog, a);
    rows.push(`<tr><td class="mono">${hex(a)}</td>${bytes.join('')}<td class="mono">${esc(fmt(m.readWord(a), st.base))}</td><td>${names ? `<b>${esc(names)}</b>` : `<span class="muted">${esc(nm)}</span>`}</td></tr>`);
  }
  return `<section class="card"><h3>データメモリ <small>（1 マス ＝ 1 バイト。下の小さい字は文字として読んだもの）</small></h3>
    <div class="scroll"><table class="datamem"><thead><tr><th>番地</th><th>+0</th><th>+1</th><th>+2</th><th>+3</th><th>ワードとして読むと</th><th>ラベル</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
    <p class="muted small">MIPS（mipsy）はリトルエンディアン：ワードのいちばん下のバイトが、いちばん小さい番地に入る</p></section>`;
}

function mode2(st: ViewState): string {
  const next = st.m.currentInstr();
  return `${explCard(st)}
  <section class="card"><h3>PC と命令 <small>PC ＝ ${hex(st.m.pc)}（次に読む命令の番地）</small></h3>
    ${next && !st.m.halted ? fieldsView(next) : '<p class="muted">プログラムは終わりました。</p>'}</section>
  ${regGrid(st)}
  ${textMemory(st)}
  ${dataMemory(st)}
  ${usesStack(st.m.prog) ? stackView(st, st.base) : ''}`;
}

export function render(st: ViewState): string {
  if (st.mode === 3) return explCard(st);
  return st.mode === 1 ? mode1(st) : mode2(st);
}

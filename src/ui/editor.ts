// エディター（CodeMirror 6）：MIPS の色付け・実行中の行・ブレークポイント・行ごとの実行回数
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { EditorState, RangeSet, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter, keymap, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { OPS, PSEUDO_OPS } from '../core/defs';

const mips = StreamLanguage.define({
  name: 'mips',
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/#.*/)) return 'comment';
    if (stream.match(/"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/'(?:[^'\\]|\\.)'/)) return 'string';
    if (stream.match(/\$\w+/)) return 'variableName';
    if (stream.match(/[A-Za-z_.][\w.]*:/)) return 'labelName';
    if (stream.match(/\.\w+/)) return 'meta';
    if (stream.match(/-?(0x[0-9a-fA-F]+|\d+)/)) return 'number';
    const w = stream.match(/[A-Za-z_][\w.]*/) as RegExpMatchArray | null;
    if (w) {
      const word = w[0].toLowerCase();
      if (Object.hasOwn(OPS, word) || PSEUDO_OPS.has(word)) return 'keyword';
      return 'labelName';
    }
    stream.next();
    return null;
  },
});

const highlight = HighlightStyle.define([
  { tag: t.comment, color: 'var(--code-comment)' },
  { tag: t.string, color: 'var(--code-string)' },
  { tag: t.variableName, color: 'var(--code-reg)', fontWeight: '600' },
  { tag: t.labelName, color: 'var(--code-label)' },
  { tag: t.keyword, color: 'var(--code-op)', fontWeight: '700' },
  { tag: t.meta, color: 'var(--code-directive)' },
  { tag: t.number, color: 'var(--code-num)' },
]);

// ---- 実行中の行・エラーの行 ----
export type LineKind = 'current' | 'error' | 'done';
const setMarks = StateEffect.define<{ line: number; kind: LineKind }[]>();
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setMarks)) {
        const ranges = e.value
          .filter((m) => m.line >= 1 && m.line <= tr.state.doc.lines)
          .sort((a, b) => a.line - b.line)
          .map((m) => Decoration.line({ class: `cm-mark-${m.kind}` }).range(tr.state.doc.line(m.line).from));
        deco = Decoration.set(ranges, true);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---- ブレークポイント ----
class BreakMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-bp';
    el.textContent = '●';
    return el;
  }
}
const bpMarker = new BreakMarker();
const toggleBp = StateEffect.define<number>(); // 行の先頭の位置
const clearBp = StateEffect.define<null>();
const bpField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(clearBp)) set = RangeSet.empty;
      if (e.is(toggleBp)) {
        let has = false;
        set.between(e.value, e.value, () => {
          has = true;
        });
        set = has ? set.update({ filter: (from) => from !== e.value }) : set.update({ add: [bpMarker.range(e.value)] });
      }
    }
    return set;
  },
});

// ---- 実行回数 ----
class CountMarker extends GutterMarker {
  constructor(readonly n: number, readonly max: number) {
    super();
  }
  eq(o: CountMarker) {
    return o.n === this.n && o.max === this.max;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-count';
    el.textContent = `${this.n}回`;
    el.style.setProperty('--heat', String(Math.min(1, this.n / Math.max(this.max, 1))));
    el.title = `この行を ${this.n} 回実行した`;
    return el;
  }
}
const setCounts = StateEffect.define<Map<number, number>>();
const countField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setCounts)) {
        const max = Math.max(0, ...e.value.values());
        const ranges = [...e.value.entries()]
          .filter(([l, n]) => n > 0 && l <= tr.state.doc.lines)
          .sort((a, b) => a[0] - b[0])
          .map(([l, n]) => new CountMarker(n, max).range(tr.state.doc.line(l).from));
        set = RangeSet.of(ranges);
      }
    }
    return set;
  },
});

export interface EditorApi {
  view: EditorView;
  getDoc(): string;
  setDoc(s: string): void;
  setMarks(m: { line: number; kind: LineKind }[], scrollTo?: number): void;
  setCounts(c: Map<number, number>): void;
  breakpoints(): Set<number>;
  clearBreakpoints(): void;
}

export function createEditor(parent: HTMLElement, doc: string, onChange: () => void): EditorApi {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        bpField,
        countField,
        gutter({
          class: 'cm-bp-gutter',
          markers: (v) => v.state.field(bpField),
          initialSpacer: () => bpMarker,
          domEventHandlers: {
            mousedown(v, line) {
              v.dispatch({ effects: toggleBp.of(line.from) });
              return true;
            },
          },
        }),
        lineNumbers({
          domEventHandlers: {
            mousedown(v, line) {
              v.dispatch({ effects: toggleBp.of(line.from) });
              return true;
            },
          },
        }),
        gutter({ class: 'cm-count-gutter', markers: (v) => v.state.field(countField), initialSpacer: () => new CountMarker(99, 99) }),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        mips,
        syntaxHighlighting(highlight),
        marksField,
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange();
        }),
        EditorView.contentAttributes.of({ 'aria-label': 'アセンブリのプログラム', spellcheck: 'false', autocapitalize: 'off' }),
      ],
    }),
  });
  return {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc(s) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s }, effects: clearBp.of(null) });
    },
    setMarks(m, scrollTo) {
      const effects: StateEffect<unknown>[] = [setMarks.of(m)];
      if (scrollTo && scrollTo <= view.state.doc.lines) {
        effects.push(EditorView.scrollIntoView(view.state.doc.line(scrollTo).from, { y: 'nearest', yMargin: 60 }));
      }
      view.dispatch({ effects });
    },
    setCounts(c) {
      view.dispatch({ effects: setCounts.of(c) });
    },
    breakpoints() {
      const out = new Set<number>();
      const it = view.state.field(bpField).iter();
      while (it.value) {
        out.add(view.state.doc.lineAt(it.from).number);
        it.next();
      }
      return out;
    },
    clearBreakpoints() {
      view.dispatch({ effects: clearBp.of(null) });
    },
  };
}

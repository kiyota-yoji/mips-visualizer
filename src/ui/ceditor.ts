// C のエディター（CodeMirror 6）：色付け・行の強調・カーソルの行を知らせる
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const KW = new Set(['int', 'void', 'if', 'else', 'while', 'for', 'return', 'break', 'continue']);

const clang = StreamLanguage.define<{ inComment: boolean }>({
  name: 'c',
  startState: () => ({ inComment: false }),
  token(stream, st) {
    if (st.inComment) {
      if (stream.skipTo('*/')) {
        stream.match('*/');
        st.inComment = false;
      } else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('/*')) {
      st.inComment = true;
      return 'comment';
    }
    if (stream.match(/\/\/.*/)) return 'comment';
    if (stream.sol() && stream.match(/\s*#.*/)) return 'meta';
    if (stream.match(/"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/'(?:[^'\\]|\\.)'?/)) return 'string';
    if (stream.match(/0x[0-9a-fA-F]+|\d+/)) return 'number';
    const w = stream.match(/[A-Za-z_]\w*/) as RegExpMatchArray | null;
    if (w) {
      if (KW.has(w[0])) return 'keyword';
      if (stream.match(/\s*\(/, false)) return 'labelName';
      return 'variableName';
    }
    stream.next();
    return null;
  },
});

const highlight = HighlightStyle.define([
  { tag: t.comment, color: 'var(--code-comment)' },
  { tag: t.string, color: 'var(--code-string)' },
  { tag: t.variableName, color: 'var(--code-reg)' },
  { tag: t.labelName, color: 'var(--code-label)' },
  { tag: t.keyword, color: 'var(--code-op)', fontWeight: '700' },
  { tag: t.meta, color: 'var(--code-directive)' },
  { tag: t.number, color: 'var(--code-num)' },
]);

export type CMark = { line: number; kind: 'hl' | 'error' };
const setMarks = StateEffect.define<CMark[]>();
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setMarks)) {
        const seen = new Set<number>();
        const ranges = e.value
          .filter((m) => m.line >= 1 && m.line <= tr.state.doc.lines && !seen.has(m.line) && seen.add(m.line))
          .sort((a, b) => a.line - b.line)
          .map((m) => Decoration.line({ class: `cm-mark-${m.kind === 'hl' ? 'current' : 'error'}` }).range(tr.state.doc.line(m.line).from));
        deco = Decoration.set(ranges, true);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export interface CEditorApi {
  view: EditorView;
  getDoc(): string;
  setDoc(s: string): void;
  setMarks(m: CMark[], scrollTo?: number): void;
  select(from: number, to: number): void;
  cursorLine(): number;
}

export function createCEditor(parent: HTMLElement, onChange: () => void, onCursor: (line: number) => void): CEditorApi {
  let lastLine = 0;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(),
        history(),
        drawSelection({ cursorBlinkRate: 1000 }),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        clang,
        syntaxHighlighting(highlight),
        marksField,
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange();
          if (u.selectionSet || u.docChanged) {
            const l = u.state.doc.lineAt(u.state.selection.main.head).number;
            if (l !== lastLine) {
              lastLine = l;
              onCursor(l);
            }
          }
        }),
        EditorView.contentAttributes.of({ 'aria-label': 'C のプログラム', spellcheck: 'false', autocapitalize: 'off' }),
      ],
    }),
  });
  return {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc(s) {
      lastLine = 0;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s }, selection: EditorSelection.cursor(0) });
    },
    setMarks(m, scrollTo) {
      const effects: StateEffect<unknown>[] = [setMarks.of(m)];
      if (scrollTo && scrollTo <= view.state.doc.lines) {
        effects.push(EditorView.scrollIntoView(view.state.doc.line(scrollTo).from, { y: 'nearest', yMargin: 40 }));
      }
      view.dispatch({ effects });
    },
    select(from, to) {
      const len = view.state.doc.length;
      view.dispatch({ selection: EditorSelection.range(Math.min(from, len), Math.min(to, len)), scrollIntoView: true });
      view.focus();
    },
    cursorLine: () => view.state.doc.lineAt(view.state.selection.main.head).number,
  };
}

// C のプログラムの例（presets/c/<id>/*.c）。モード④で使う
import type { SourceFile } from './compiler/pipeline';

const files = import.meta.glob('../presets/c/**/*.c', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export type Stage = 'tokens' | 'ast' | 'asm' | 'obj' | 'link' | 'run';

export interface CPreset {
  id: string;
  title: string;
  note?: string;
  stage?: Stage; // 最初に開く段
  files: SourceFile[];
}

const META: Omit<CPreset, 'files'>[] = [
  { id: 'c01-arith', title: '足し算と引き算：f = (g + h) − (i + j)', note: '① 字句解析 → ② 構文解析 で、式が「木」になるのを見る', stage: 'tokens' },
  { id: 'c02-max', title: 'if と else：大きいほうを返す max', note: 'max は関数を呼ばない（リーフ）ので、a・b は $a0・$a1 のまま使う', stage: 'asm' },
  { id: 'c03-loop', title: 'for と while：1 から 10 までの合計', note: 'for の条件が「成り立たなければ抜ける」分岐になる', stage: 'asm' },
  { id: 'c04-array', title: '配列：A[k] の番地は 先頭 ＋ k × 4', note: 'sll で × 4 してから add で先頭に足す', stage: 'asm' },
  { id: 'c05-link', title: '別のファイルの関数を呼ぶ：main.c と mathfuncs.c', note: '④ で main.o の jal add が 0 のまま → ⑤ リンクで番地が入る', stage: 'obj' },
  { id: 'c06-sort', title: 'swap と sort（第07回の例題）', note: 'swap はリーフ、sort は swap を呼ぶので $ra と $s を退避する', stage: 'asm' },
  { id: 'c07-fact', title: '再帰：階乗 fact(5)', note: '③ ブロック図で動かすと、呼ぶたびにスタックが伸びるのが見える', stage: 'asm' },
  { id: 'c08-gcd', title: 'while と %：最大公約数', note: '% は div のあと mfhi（あまり）', stage: 'asm' },
  { id: 'c09-chars', title: '文字：putchar で A〜Z', note: "'A' は数 65（文字コード）", stage: 'asm' },
];

export const CPRESETS: CPreset[] = META.flatMap((m) => {
  const fs = Object.entries(files)
    .filter(([p]) => p.startsWith(`../presets/c/${m.id}/`))
    .map(([p, source]) => ({ name: p.split('/').at(-1)!, source }))
    .sort((a, b) => (a.name === 'main.c' ? -1 : b.name === 'main.c' ? 1 : a.name.localeCompare(b.name)));
  return fs.length ? [{ ...m, files: fs }] : [];
});

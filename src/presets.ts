// 授業のプログラム（presets/ の .s ファイル）。解答は入れない
const files = import.meta.glob('../presets/**/*.s', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface Preset {
  id: string; // URL の ?preset= に使う（例 08-sample03）
  lesson: string;
  title: string;
  mode: 1 | 2;
  note?: string;
  template?: boolean; // 課題のひな形（そのままでは完成していない）
  source: string;
}

const META: Omit<Preset, 'source' | 'lesson'>[] = [
  { id: '05-arith', title: '足し算と引き算：f = (g + h) − (i + j)', mode: 1 },
  { id: '05-array', title: '配列の読み書き：A[8] = h + A[8]', mode: 2, note: 'lw・sw の番地が 先頭 ＋ 32 になることを見る' },
  { id: '05-logic', title: '論理演算とシフト', mode: 2, note: '表示を「2進数」にして、ビットの変わり方を見る' },
  { id: '06-if', title: 'if 文：if (x == y) z = z + 1', mode: 1, note: 'y を 5 に書きかえて、もう一度実行してみる' },
  { id: '06-loop', title: 'くり返し：s に 5 を 3 回足す', mode: 1, note: '行の左の「回」で、beq を何回通ったかを見る' },
  { id: '06-slt', title: 'slt と sltu：−1 と 1 を比べる', mode: 2, note: '同じビットの並びでも、符号ありと符号なしで結果が変わる' },
  { id: '06-jal', title: '関数を呼ぶ：jal と jr $ra', mode: 2, note: 'jal で $ra に何が入るかを見る' },
  { id: '06-stack', title: 'スタックに退避する：3ワードで −12', mode: 2, note: '$sp の矢印が 12 バイト下がることを見る' },
  { id: '06-string', title: '文字列の長さ："Cat" は 4 バイト', mode: 2, note: '1 文字 1 バイト、最後に 0' },
  { id: '08-sample01', title: 'sample01 Hello, world!', mode: 1 },
  { id: '08-sample02', title: 'sample02 if 文（beq と j）', mode: 1 },
  { id: '08-sample03', title: 'sample03 配列を先頭から探す', mode: 1 },
  { id: '08-sample04', title: 'sample04 関数：最大公約数', mode: 2 },
  { id: '08-sample05', title: 'sample05 関数とスタック（2 × x ＋ 1）', mode: 2 },
  { id: '08-ex08-1', title: '課題(1) 足し算と引き算（ひな形）', mode: 1, template: true },
  { id: '08-ex08-2', title: '課題(2) 配列の合計（ひな形）', mode: 1, template: true },
  { id: '08-ex08-3', title: '課題(3) トランプの表示（ひな形）', mode: 1, template: true },
  { id: '08-ex08-4', title: '課題(4) 九九の表（ひな形）', mode: 1, template: true },
  { id: '11-CSF_L11_sample01', title: 'サンプル1 16ビットの足し算・引き算', mode: 2 },
  { id: '11-CSF_L11_sample02', title: 'サンプル2 掛け算と割り算', mode: 2 },
  { id: '11-CSF_L11_ex04', title: '課題(4) うるう年の判定（ひな形）', mode: 2, template: true },
  { id: '11-CSF_L11_ex05', title: 'オプション課題（ひな形）', mode: 2, template: true },
];

export const PRESETS: Preset[] = META.flatMap((m) => {
  const [lesson, ...rest] = m.id.split('-');
  const source = files[`../presets/${lesson}/${rest.join('-')}.s`];
  return source === undefined ? [] : [{ ...m, lesson, source }];
});

export const LESSON_TITLES: Record<string, string> = {
  '05': '第05回 命令セットと数の表現',
  '06': '第06回 制御・関数・文字列',
  '08': '第08回 演習',
  '11': '第11回 演習',
};

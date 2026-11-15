// C のコンパイラ：手元の C コンパイラ（cc）で動かした結果と、MIPS に訳して動かした結果を比べる
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Machine } from '../src/core/machine';
import { type SourceFile, build } from '../src/compiler/pipeline';

const golden: Record<string, string> = JSON.parse(readFileSync(join(__dirname, 'c_golden.json'), 'utf8'));

function runC(files: SourceFile[]) {
  const b = build(files);
  for (const f of b.files) expect([f.name, f.error]).toEqual([f.name, null]);
  expect(b.link?.errors).toEqual([]);
  const m = new Machine(b.link!.program!, { strictUninit: false });
  const r = m.run();
  return { b, m, r };
}

const presetDir = join(__dirname, '..', 'presets', 'c');
const cases: [string, SourceFile[]][] = [
  ...readdirSync(presetDir).map((d): [string, SourceFile[]] => [
    `preset:${d}`,
    readdirSync(join(presetDir, d))
      .filter((f) => f.endsWith('.c'))
      .sort((a, b) => (a === 'main.c' ? -1 : b === 'main.c' ? 1 : a.localeCompare(b)))
      .map((f) => ({ name: f, source: readFileSync(join(presetDir, d, f), 'utf8') })),
  ]),
  ...readdirSync(join(__dirname, 'c'))
    .filter((f) => f.endsWith('.c'))
    .map((f): [string, SourceFile[]] => [`test:${f.replace(/\.c$/, '')}`, [{ name: 'main.c', source: readFileSync(join(__dirname, 'c', f), 'utf8') }]]),
];

describe('cc と同じ出力になる', () => {
  for (const [name, files] of cases) {
    it(name, () => {
      const { m, r } = runC(files);
      expect(r.status).toBe('halted');
      expect(m.output).toBe(golden[name]);
    });
  }
});

describe('.o とリンク', () => {
  for (const [name, files] of cases) {
    it(`${name}：番地を埋める命令のほかは、.o と実行ファイルで機械語が同じ`, () => {
      const { b } = runC(files);
      const prog = b.link!.program!;
      const byAddr = new Map(prog.text.map((x) => [x.addr, x.word]));
      b.files.forEach((f, i) => {
        const base = b.link!.layout[i].textStart;
        for (const oi of f.obj!.text) {
          const fin = byAddr.get(base + oi.off);
          if (!oi.reloc) expect([f.name, oi.off, fin]).toEqual([f.name, oi.off, oi.word]);
        }
      });
    });
  }

  it('別のファイルの add は .o では 0、リンクで番地が入る（第07回スライド21・付録3 と同じ形）', () => {
    const files = cases.find(([n]) => n === 'preset:c05-link')![1];
    const { b } = runC(files);
    const main = b.files[0].obj!;
    const jal = main.text.find((x) => x.text === 'jal add')!;
    expect(jal.word).toBe(0x0c000000);
    expect(jal.reloc).toMatchObject({ kind: 'J26', symbol: 'add', external: true });
    expect(main.symbols.find((s) => s.name === 'add')).toMatchObject({ section: '未定義' });
    const p = b.link!.patches.find((x) => x.reloc.symbol === 'add')!;
    const addAddr = b.link!.symbols.find((s) => s.name === 'add')!.addr;
    expect(p.after).toBe((0x0c000000 | (addAddr >>> 2)) >>> 0);
  });

  it('関数の中身がないとリンクのエラー', () => {
    const files = cases.find(([n]) => n === 'preset:c05-link')![1].slice(0, 1);
    const b = build(files);
    expect(b.files[0].error).toBeNull();
    expect(b.files[0].obj).not.toBeNull();
    expect(b.link!.ok).toBe(false);
    expect(b.link!.errors.join()).toContain('add');
  });
});

describe('コンパイルのエラー', () => {
  const err = (src: string) => build([{ name: 'main.c', source: src }]).files[0].error;
  it('; がない', () => expect(err('int main(void) {\n int x = 1\n return 0;\n}')?.message).toContain(';'));
  it('宣言していない変数', () => expect(err('int main(void) { y = 1; return 0; }')?.message).toContain('y'));
  it('宣言していない関数', () => expect(err('int main(void) { f(1); return 0; }')?.message).toContain('f'));
  it('使えない型', () => expect(err('float x;')?.message).toContain('float'));
  it('行の番号', () => expect(err('int main(void) {\n\n  x = 3;\n}')?.line).toBe(3));
});

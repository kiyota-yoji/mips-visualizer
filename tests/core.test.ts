import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assemble } from '../src/core/assembler';
import { REG_NAMES } from '../src/core/defs';
import { Machine } from '../src/core/machine';

const run = (src: string, input: string[] = []) => {
  const p = assemble(src);
  expect(p.errors).toEqual([]);
  const m = new Machine(p);
  m.inputQueue.push(...input);
  const r = m.run();
  return { m, r, p };
};
const reg = (m: Machine, n: string) => m.regs[REG_NAMES.indexOf(n as never)] | 0;

describe('突き合わせ：mips_sim.py と同じ結果になる', () => {
  const root = join(__dirname, '..', 'presets');
  for (const lesson of ['08', '11']) {
    for (const f of readdirSync(join(root, lesson)).filter((x) => x.endsWith('.s'))) {
      const name = `${lesson}-${f.replace(/\.s$/, '')}`;
      const gold = JSON.parse(readFileSync(join(__dirname, 'golden', `${name}.json`), 'utf8'));
      if (gold.error) continue; // mips_sim.py が止まるもの（ひな形など）は別に確かめる
      it(name, () => {
        const { m, r } = run(readFileSync(join(root, lesson, f), 'utf8'));
        expect(r.status).toBe('halted');
        expect(m.output).toBe(gold.output);
        for (const [n, v] of Object.entries(gold.regs)) expect([n, m.regs[REG_NAMES.indexOf(n as never)]]).toEqual([n, v]);
        const data = [...m.prog.data].map((_, i) => m.readByte(0x10010000 + i));
        expect(data).toEqual(gold.data);
      });
    }
  }
});

describe('機械語と番地が mipsy と同じ（第08回 lesson_plan に記録した値）', () => {
  const code = (lesson: string, f: string) => assemble(readFileSync(join(__dirname, '..', 'presets', lesson, f), 'utf8'));
  const word = (p: ReturnType<typeof assemble>, text: string) =>
    p.text.find((i) => i.source.replace(/\s+/g, ' ') === text)!.word.toString(16).padStart(8, '0');
  it('sample05', () => {
    const p = code('08', 'sample05.s');
    expect(word(p, 'jal compute')).toBe('0c100007');
    expect(word(p, 'addi $sp, $sp, -4')).toBe('23bdfffc');
    expect(word(p, 'sw $s0, 0($sp)')).toBe('afb00000');
    expect(word(p, 'jr $ra')).toBe('03e00008');
  });
  it('sample02', () => {
    const p = code('08', 'sample02.s');
    expect(word(p, 'add $s0, $s1, $s2')).toBe('02328020');
    expect(word(p, 'sub $s0, $s1, $s2')).toBe('02328022');
    expect(word(p, 'j END')).toBe('08100008');
  });
});

describe('命令', () => {
  it('beq の飛び先は PC+4 + 定数×4', () => {
    const { p } = run('main: li $t0, 1\n beq $t0, $t0, L\n nop\n nop\n L: li $v0, 10\n syscall');
    const b = p.text.find((i) => i.op === 'beq')!;
    expect(b.imm).toBe(2);
    expect(b.target).toBe(b.addr + 4 + 2 * 4);
  });
  it('slt は符号ありで比べる', () => {
    const { m } = run('main: li $t0, -1\n li $t1, 1\n slt $t2, $t0, $t1\n sltu $t3, $t0, $t1\n li $v0, 10\n syscall');
    expect(reg(m, 't2')).toBe(1);
    expect(reg(m, 't3')).toBe(0);
  });
  it('.asciiz は終端の 0 を含めて 1 文字 1 バイト', () => {
    const p = assemble('.data\ns: .asciiz "Cat"\nn: .word 7\n.text\nmain: li $v0, 10\n syscall');
    expect(p.dataLabels[0]).toMatchObject({ name: 's', size: 4, count: 3 });
    expect(p.labels.get('n')).toBe(0x10010004);
  });
  it('add のあふれで止まる（addu は止まらない）', () => {
    const p = assemble('main: li $t0, 0x7fffffff\n addu $t1, $t0, $t0\n add $t2, $t0, $t0\n li $v0, 10\n syscall');
    const m = new Machine(p);
    const r = m.run();
    expect(r.status).toBe('error');
    expect(r.error!.line).toBe(3);
  });
  it('値の入っていないレジスタを読むと止まる', () => {
    const m = new Machine(assemble('main: add $t0, $t1, $t2\n li $v0, 10\n syscall'));
    expect(m.run().error!.message).toContain('$t1');
  });
  it('設定で止めないこともできる', () => {
    const m = new Machine(assemble('main: add $t0, $t1, $t2\n li $v0, 10\n syscall'), { strictUninit: false });
    expect(m.run().status).toBe('halted');
  });
  it('疑似命令の展開', () => {
    const p = assemble('.data\nx: .word 5\n.text\nmain: li $t0, 100000\n la $t1, x\n lw $t2, x\n blt $t0, $t1, main\n move $t3, $t0\n li $v0, 10\n syscall');
    expect(p.text.map((i) => i.text)).toEqual([
      'lui $at, 1', 'ori $t0, $at, 34464',
      'lui $at, 4097', 'ori $t1, $at, 0',
      'lui $at, 4097', 'lw $t2, 0($at)',
      'slt $at, $t0, $t1', 'bne $at, $zero, main',
      'addu $t3, $zero, $t0',
      'addiu $v0, $zero, 10', 'syscall',
    ]);
  });
  it('mult・div・mfhi・mflo', () => {
    const { m } = run('main: li $t0, -7\n li $t1, 2\n div $t0, $t1\n mflo $t2\n mfhi $t3\n mul $t4, $t0, $t1\n li $v0, 10\n syscall');
    expect([reg(m, 't2'), reg(m, 't3'), reg(m, 't4')]).toEqual([-3, -1, -14]);
  });
  it('read_int', () => {
    const { m } = run('main: li $v0, 5\n syscall\n move $a0, $v0\n li $v0, 1\n syscall\n li $v0, 10\n syscall', ['42']);
    expect(m.output).toBe('42\n42');
  });
  it('入力がないと入力待ちになる', () => {
    const m = new Machine(assemble('main: li $v0, 5\n syscall\n li $v0, 10\n syscall'));
    m.step();
    expect(m.step().status).toBe('input');
    m.provideInput('3');
    expect(m.step().status).toBe('ok');
    expect(reg(m, 'v0')).toBe(3);
  });
});

describe('戻る', () => {
  it('最後まで実行して全部戻すと最初の状態になる', () => {
    const src = readFileSync(join(__dirname, '..', 'presets', '08', 'sample05.s'), 'utf8');
    const m = new Machine(assemble(src));
    const regs0 = [...m.regs];
    const mem0 = new Map(m.mem);
    m.run();
    while (m.canBack) m.back();
    expect([...m.regs]).toEqual(regs0);
    expect(m.mem).toEqual(mem0);
    expect(m.output).toBe('');
    expect(m.pc).toBe(m.prog.entry);
  });
});

describe('エラーメッセージ', () => {
  it('命令名の打ち間違いに候補を出す', () => {
    expect(assemble('main: ad $t0, $t1, $t2').errors[0].message).toContain('add ですか');
  });
  it('$ の付け忘れ', () => {
    expect(assemble('main: add t0, $t1, $t2').errors[0].message).toContain('$t0');
  });
  it('ラベルがない', () => {
    expect(assemble('main: j Loop').errors[0].message).toContain('Loop');
  });
  it('main がない', () => {
    expect(assemble('li $v0, 10\nsyscall').errors[0].message).toContain('main');
  });
});

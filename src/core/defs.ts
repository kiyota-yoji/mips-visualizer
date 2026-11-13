// MIPS の定数・レジスタ名・命令の形式の定義

export const TEXT_BASE = 0x00400000;
export const DATA_BASE = 0x10010000;
export const STACK_TOP = 0x7ffffefc;
export const GP_INIT = 0x10008000;

export const REG_NAMES = [
  'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3',
  't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',
  't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra',
] as const;

export const REG_INDEX: Record<string, number> = Object.fromEntries(
  REG_NAMES.map((n, i) => [n, i]),
);
REG_INDEX['s8'] = 30;

/** レジスタの役割（画面の説明用） */
export const REG_ROLE: Record<string, string> = {
  zero: 'いつも 0', at: 'アセンブラ用', v0: '結果・syscall 番号', v1: '結果',
  a0: '引数1', a1: '引数2', a2: '引数3', a3: '引数4',
  gp: 'グローバル', sp: 'スタックの先頭', fp: 'フレーム', ra: '戻り先の番地',
};
for (let i = 0; i <= 9; i++) REG_ROLE[`t${i}`] = '一時（自由に使う）';
for (let i = 0; i <= 7; i++) REG_ROLE[`s${i}`] = '保存（元に戻す約束）';
REG_ROLE['k0'] = REG_ROLE['k1'] = 'OS 用';

export type Format = 'R' | 'I' | 'J';
export type Group = 'arith' | 'logic' | 'mem' | 'branch' | 'jump' | 'sys' | 'compare';

/** 本当の命令（機械語になるもの）の定義 */
export interface OpDef {
  format: Format;
  opcode: number;
  funct?: number;
  group: Group;
  /** オペランドの並び。r=レジスタ, i=即値, m=番地 off(base), l=ラベル(分岐), t=ラベル(ジャンプ), s=シフト量 */
  syntax: string;
}

export const OPS: Record<string, OpDef> = {
  // R 形式（算術・論理）
  add: { format: 'R', opcode: 0, funct: 0x20, group: 'arith', syntax: 'd,s,t' },
  addu: { format: 'R', opcode: 0, funct: 0x21, group: 'arith', syntax: 'd,s,t' },
  sub: { format: 'R', opcode: 0, funct: 0x22, group: 'arith', syntax: 'd,s,t' },
  subu: { format: 'R', opcode: 0, funct: 0x23, group: 'arith', syntax: 'd,s,t' },
  and: { format: 'R', opcode: 0, funct: 0x24, group: 'logic', syntax: 'd,s,t' },
  or: { format: 'R', opcode: 0, funct: 0x25, group: 'logic', syntax: 'd,s,t' },
  xor: { format: 'R', opcode: 0, funct: 0x26, group: 'logic', syntax: 'd,s,t' },
  nor: { format: 'R', opcode: 0, funct: 0x27, group: 'logic', syntax: 'd,s,t' },
  slt: { format: 'R', opcode: 0, funct: 0x2a, group: 'compare', syntax: 'd,s,t' },
  sltu: { format: 'R', opcode: 0, funct: 0x2b, group: 'compare', syntax: 'd,s,t' },
  sll: { format: 'R', opcode: 0, funct: 0x00, group: 'logic', syntax: 'd,t,h' },
  srl: { format: 'R', opcode: 0, funct: 0x02, group: 'logic', syntax: 'd,t,h' },
  sra: { format: 'R', opcode: 0, funct: 0x03, group: 'logic', syntax: 'd,t,h' },
  sllv: { format: 'R', opcode: 0, funct: 0x04, group: 'logic', syntax: 'd,t,s' },
  srlv: { format: 'R', opcode: 0, funct: 0x06, group: 'logic', syntax: 'd,t,s' },
  srav: { format: 'R', opcode: 0, funct: 0x07, group: 'logic', syntax: 'd,t,s' },
  jr: { format: 'R', opcode: 0, funct: 0x08, group: 'jump', syntax: 's' },
  jalr: { format: 'R', opcode: 0, funct: 0x09, group: 'jump', syntax: 's' },
  syscall: { format: 'R', opcode: 0, funct: 0x0c, group: 'sys', syntax: '' },
  mfhi: { format: 'R', opcode: 0, funct: 0x10, group: 'arith', syntax: 'd' },
  mflo: { format: 'R', opcode: 0, funct: 0x12, group: 'arith', syntax: 'd' },
  mult: { format: 'R', opcode: 0, funct: 0x18, group: 'arith', syntax: 's,t' },
  multu: { format: 'R', opcode: 0, funct: 0x19, group: 'arith', syntax: 's,t' },
  div: { format: 'R', opcode: 0, funct: 0x1a, group: 'arith', syntax: 's,t' },
  divu: { format: 'R', opcode: 0, funct: 0x1b, group: 'arith', syntax: 's,t' },
  mul: { format: 'R', opcode: 0x1c, funct: 0x02, group: 'arith', syntax: 'd,s,t' },
  // I 形式
  addi: { format: 'I', opcode: 0x08, group: 'arith', syntax: 't,s,i' },
  addiu: { format: 'I', opcode: 0x09, group: 'arith', syntax: 't,s,i' },
  slti: { format: 'I', opcode: 0x0a, group: 'compare', syntax: 't,s,i' },
  sltiu: { format: 'I', opcode: 0x0b, group: 'compare', syntax: 't,s,i' },
  andi: { format: 'I', opcode: 0x0c, group: 'logic', syntax: 't,s,u' },
  ori: { format: 'I', opcode: 0x0d, group: 'logic', syntax: 't,s,u' },
  xori: { format: 'I', opcode: 0x0e, group: 'logic', syntax: 't,s,u' },
  lui: { format: 'I', opcode: 0x0f, group: 'logic', syntax: 't,u' },
  beq: { format: 'I', opcode: 0x04, group: 'branch', syntax: 's,t,l' },
  bne: { format: 'I', opcode: 0x05, group: 'branch', syntax: 's,t,l' },
  lb: { format: 'I', opcode: 0x20, group: 'mem', syntax: 't,m' },
  lh: { format: 'I', opcode: 0x21, group: 'mem', syntax: 't,m' },
  lw: { format: 'I', opcode: 0x23, group: 'mem', syntax: 't,m' },
  lbu: { format: 'I', opcode: 0x24, group: 'mem', syntax: 't,m' },
  lhu: { format: 'I', opcode: 0x25, group: 'mem', syntax: 't,m' },
  sb: { format: 'I', opcode: 0x28, group: 'mem', syntax: 't,m' },
  sh: { format: 'I', opcode: 0x29, group: 'mem', syntax: 't,m' },
  sw: { format: 'I', opcode: 0x2b, group: 'mem', syntax: 't,m' },
  // J 形式
  j: { format: 'J', opcode: 0x02, group: 'jump', syntax: 'a' },
  jal: { format: 'J', opcode: 0x03, group: 'jump', syntax: 'a' },
};

export const PSEUDO_OPS = new Set([
  'li', 'la', 'move', 'nop', 'not', 'neg', 'negu', 'b', 'beqz', 'bnez',
  'blt', 'bgt', 'ble', 'bge', 'bltu', 'bgtu', 'bleu', 'bgeu', 'rem', 'remu',
]);

export const u32 = (x: number): number => x >>> 0;
export const s32 = (x: number): number => x | 0;
export const s16 = (x: number): number => ((x & 0xffff) << 16) >> 16;

export function hex(x: number, digits = 8): string {
  return '0x' + (x >>> 0).toString(16).padStart(digits, '0');
}

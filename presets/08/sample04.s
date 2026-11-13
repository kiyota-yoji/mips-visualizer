# sample04.s  関数（jal・jr）（計算機科学の基礎 第08回）
# 引き算だけで最大公約数を求める（ユークリッドの互除法の引き算版）
# Python なら:
#   def gcd(a0, a1):
#       while a0 != a1:
#           if a0 > a1: a0 -= a1
#           else:       a1 -= a0
#       return a0
#   print(gcd(45, 60), end="")      # 45,60 → 45,15 → 30,15 → 15,15 → 15
.data
num1:   .word 45
num2:   .word 60

.text
main:
    lw   $a0, num1         # 引数1 $a0 = 45
    lw   $a1, num2         # 引数2 $a1 = 60
    jal  gcd               # gcd を呼ぶ（$ra = 次の命令の番地）

    move $a0, $v0          # 結果 $v0 を表示する
    li   $v0, 1            # print_int
    syscall

    li   $v0, 10           # exit
    syscall

# gcd：引数 $a0・$a1、結果 $v0
gcd:
    beq  $a0, $a1, gcd_end # 2つが等しくなったら終わり
    slt  $t0, $a0, $a1     # $a0 < $a1 なら $t0 = 1
    bne  $t0, $zero, a1big # $a0 < $a1 なら a1big へ
    sub  $a0, $a0, $a1     # $a0 が大きい：$a0 = $a0 - $a1
    j    gcd
a1big:
    sub  $a1, $a1, $a0     # $a1 が大きい：$a1 = $a1 - $a0
    j    gcd
gcd_end:
    move $v0, $a0          # 結果を $v0 に
    jr   $ra               # 呼び出し元（jal の次）へ戻る

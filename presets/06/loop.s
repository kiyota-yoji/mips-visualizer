# 第06回 例2：くり返し（s に 5 を 3 回足す）
# i ＝ $t0（最初は 0）、$t1 ＝ 3、s ＝ $s0（最初は 0）
# 何回 beq を通ったか、行の左の回数で確かめる
.text
main:
    li   $t0, 0            # i = 0
    li   $t1, 3            # くり返す回数
    li   $s0, 0            # s = 0
Loop:
    beq  $t0, $t1, Exit    # i == 3 なら Exit へ飛ぶ
    addi $t0, $t0, 1       # i = i + 1
    addi $s0, $s0, 5       # s = s + 5
    j    Loop              # Loop へ戻る
Exit:
    move $a0, $s0          # s を表示する（15）
    li   $v0, 1            # print_int
    syscall
    li   $v0, 10           # exit
    syscall

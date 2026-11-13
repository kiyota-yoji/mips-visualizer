# ex08-1.s  課題 (1)　足し算と引き算（計算機科学の基礎 第08回）
# 学籍番号：
# 氏名：
# 実行結果（Output に出たものを写す）：
#
# 課題：コメントを参考にして、nop（何もしない命令）の行を正しい命令に書き直し、
#       実行して結果を確かめてください。（Python なら t0 = 10; t1 = 5; t2 = 2; print(t0 + t1 - t2)）
.text
main:
    li   $t0, 10          # $t0 = 10
    nop                    # $t1 = 5
    nop                    # $t2 = 2

    add  $t0, $t0, $t1   # $t0 = $t0 + $t1
    nop                    # $t0 = $t0 - $t2

    move $a0, $t0         # 結果を $a0（syscall の引数）へ
    li   $v0, 1           # print_int
    syscall

    li   $v0, 10          # exit
    syscall

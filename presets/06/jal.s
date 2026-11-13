# 第06回 例4：関数を呼ぶ（jal）と戻る（jr $ra）
# jal は「次の命令の番地」を $ra に入れてから飛ぶ
.text
main:
    li   $a0, 3            # 引数 $a0 = 3
    li   $a1, 4            # 引数 $a1 = 4
    jal  sum               # sum を呼ぶ（$ra = 次の命令の番地）
    move $a0, $v0          # 戻ってきたら、結果 $v0 を表示する
    li   $v0, 1            # print_int
    syscall
    li   $v0, 10           # exit
    syscall

sum:
    add  $v0, $a0, $a1     # 結果 $v0 = $a0 + $a1
    jr   $ra               # $ra の番地（jal の次）へ戻る

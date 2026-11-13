# 第06回 例6：文字列は 1 文字 1 バイト、最後に 0
# "Cat" は 'C' 'a' 't' 0 の 4 バイト。0 が出てくるまで 1 バイトずつ数える
.data
str:    .asciiz "Cat"
.text
main:
    la   $t0, str          # $t0 = 文字列の先頭の番地
    li   $t1, 0            # 文字の数 = 0
Loop:
    lbu  $t2, 0($t0)       # 1 バイト読む
    beq  $t2, $zero, Exit  # 0（終わりの印）なら Exit へ
    addi $t1, $t1, 1       # 文字の数 + 1
    addi $t0, $t0, 1       # 次の番地（1 バイト先）
    j    Loop
Exit:
    move $a0, $t1          # 文字の数（3）を表示する
    li   $v0, 1            # print_int
    syscall
    li   $v0, 10           # exit
    syscall

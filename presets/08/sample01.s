# sample01.s  Hello, world!（計算機科学の基礎 第08回）
# Python なら: print("Hello, world!", end="")
.data                      # ここからデータ（文字列・配列など）
msg:    .asciiz "Hello, world!"   # 文字列。最後に 0 が付く

.text                      # ここから命令
main:                      # MISPy Web は main から実行する
    la   $a0, msg          # $a0 = 文字列の先頭の番地（syscall の引数）
    li   $v0, 4            # syscall 4 番 = print_string（文字列を表示）
    syscall                # 表示する

    li   $v0, 10           # syscall 10 番 = exit（終了）
    syscall                # 最後は必ず exit で終わる

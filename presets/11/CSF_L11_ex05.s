# 計算機科学の基礎 第11回 オプション課題：課題(1) の計算を MIPS で確かめる
#   a_vals[i] と b_vals[i] を、i = 0 は足し算、i = 1 は引き算、i = 2 は掛け算して、
#   結果の下の16ビットを answer[i] に書く（符号なしで読み込む：lhu）。
#   動いたら「data」のデータセグメントで answer を読み、課題(1) の答えと比べる（リトルエンディアンに注意）。
.data
a_vals: .half 0x4A3C, 0x3B07, 0x0036
b_vals: .half 0x5E91, 0x6C25, 0x0015
answer: .half 0, 0, 0

.text
main:
    # ここにコードを書く



    li   $v0, 10            # syscall 10：終了
    syscall

# 計算機科学の基礎 第11回 サンプル2：掛け算と割り算（mul・mult・div・mfhi・mflo）
# mipsy Web で実行し、レジスタの値を見る。
.text
main:
    li   $t0, 13
    li   $t1, 5

    div  $t0, $t1           # 13 ÷ 5：商は LO に、余りは HI に入る
    mflo $t2                # $t2 = 商   = 2
    mfhi $t3                # $t3 = 余り = 3

    mul  $t4, $t0, $t1      # $t4 = 13 × 5 = 65（下の32ビットだけ残る）

    # 32ビットに入りきらない掛け算：65536 × 65536 = 2^32
    li   $t5, 65536
    mul  $t6, $t5, $t5      # 下の32ビットだけ → $t6 = 0（あふれても知らせない）
    mult $t5, $t5           # 64ビットの結果を HI（上32ビット）と LO（下32ビット）に
    mfhi $t7                # $t7 = 1
    mflo $t8                # $t8 = 0

    li   $v0, 10            # syscall 10：終了
    syscall

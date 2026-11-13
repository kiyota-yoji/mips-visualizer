#!/usr/bin/env python3
"""突き合わせテストの期待値を作る（教員用の mips_sim.py で実行した結果を JSON にする）。

使い方:
    python3 scripts/make_golden.py <mips_sim.py のパス> <出力先ディレクトリ> <.s ファイル>...

mips_sim.py は授業のリポジトリ（markdown-lecture-factory）にあり、このリポジトリには含めない。
$ra と $at はテキストの番地の決め方（疑似命令の展開）が違うので比べない。
"""
import importlib.util
import json
import pathlib
import sys

spec = importlib.util.spec_from_file_location("mips_sim", sys.argv[1])
ms = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ms)
out_dir = pathlib.Path(sys.argv[2])
out_dir.mkdir(parents=True, exist_ok=True)
for path in sys.argv[3:]:
    p = pathlib.Path(path)
    m = ms.Machine(ms.assemble(p.read_text(encoding="utf-8")))
    try:
        m.run()
        err = None
    except ms.MipsError as e:
        err = str(e)
    regs = {
        n: m.reg[i]
        for i, n in enumerate(ms.REG_NAMES)
        if m.init[i] and n not in ("zero", "at", "ra", "sp", "gp", "fp")
    }
    data = [m.mem.get(ms.DATA_BASE + i, 0) for i in range(len(m.prog.data))]
    res = {"output": "".join(m.out), "error": err, "regs": regs, "data": data, "hi": m.hi, "lo": m.lo}
    name = f"{p.parent.name}-{p.stem}.json"
    (out_dir / name).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(name, "error" if err else "ok")

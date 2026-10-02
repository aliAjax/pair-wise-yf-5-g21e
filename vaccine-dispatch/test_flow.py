#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""疫苗调拨台自动化验证：

1. 并发领用：5 个接种点同时抢 250 支库存，验证先到先得、不超卖、缺口正确；
2. 业务流程：FEFO 出库顺序、冷藏箱超装不放行、温度超标自动作废退回库存、
   作废单不可签收、处置结果落库可查。

运行：python3 test_flow.py
"""
import os
import tempfile
import threading

import app


def fresh_db():
    tmp = tempfile.mkdtemp(prefix="vax_test_")
    app.DB_PATH = os.path.join(tmp, "test.db")
    app.init_db()


def test_concurrent_requisition():
    fresh_db()
    conn = app.get_db()
    conn.execute("INSERT INTO vaccines(code, name) VALUES('TEST', '测试疫苗')")
    vid = conn.execute("SELECT id FROM vaccines WHERE code='TEST'").fetchone()["id"]
    conn.execute("INSERT INTO batches(vaccine_id, batch_no, expiry_date, quantity) VALUES(?,?,?,?)",
                 (vid, "T001", "2026-12-31", 100))
    conn.execute("INSERT INTO batches(vaccine_id, batch_no, expiry_date, quantity) VALUES(?,?,?,?)",
                 (vid, "T002", "2027-06-30", 150))
    for i in range(5):
        conn.execute("INSERT INTO sites(name) VALUES(?)", (f"接种点{i+1}",))
    conn.commit()
    conn.close()

    results, errors = [None] * 5, []

    def worker(i):
        try:
            results[i] = app.create_requisition(i + 1, vid, 100)
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, errors
    total_alloc = sum(r["allocated"] for r in results)
    total_short = sum(r["shortage"] for r in results)
    assert total_alloc == 250, f"超卖/少卖：共分出 {total_alloc}"
    assert total_short == 250, f"缺口合计应为 250，实际 {total_short}"
    winners = sum(1 for r in results if r["allocated"] == 100)
    partial = sum(1 for r in results if 0 < r["allocated"] < 100)
    losers = sum(1 for r in results if r["allocated"] == 0)
    assert (winners, partial, losers) == (2, 1, 2), (winners, partial, losers)

    conn = app.get_db()
    left = {r["batch_no"]: r["quantity"] for r in conn.execute("SELECT batch_no, quantity FROM batches")}
    conn.close()
    assert left == {"T001": 0, "T002": 0}, left

    print("[通过] 并发领用：5 点同时各申领 100 支，库存 250 支")
    for r in results:
        print(f"        {r['site']}: 分到 {r['allocated']} 支，还差 {r['shortage']} 支")
    print("        无超卖，先到先得，后到者看到缺口。")


def test_full_flow():
    fresh_db()
    conn = app.get_db()
    conn.execute("INSERT INTO vaccines(code, name) VALUES('FLU', '流感疫苗')")
    vid = conn.execute("SELECT id FROM vaccines WHERE code='FLU'").fetchone()["id"]
    # 三个批次：效期近→远；另有一批已过期，不应参与出库
    conn.execute("INSERT INTO batches(vaccine_id, batch_no, expiry_date, quantity) VALUES(?,?,?,?)",
                 (vid, "F-OLD", "2026-01-01", 500))
    conn.execute("INSERT INTO batches(vaccine_id, batch_no, expiry_date, quantity) VALUES(?,?,?,?)",
                 (vid, "F-A", "2026-12-31", 80))
    conn.execute("INSERT INTO batches(vaccine_id, batch_no, expiry_date, quantity) VALUES(?,?,?,?)",
                 (vid, "F-B", "2027-06-30", 300))
    conn.execute("INSERT INTO sites(name) VALUES('城北接种点')")
    conn.execute("INSERT INTO cold_boxes(name, capacity) VALUES('小冷藏箱', 100)")
    conn.execute("INSERT INTO cold_boxes(name, capacity) VALUES('大冷藏箱', 500)")
    conn.commit()
    site_id = conn.execute("SELECT id FROM sites").fetchone()["id"]
    small_box = conn.execute("SELECT id FROM cold_boxes WHERE name='小冷藏箱'").fetchone()["id"]
    big_box = conn.execute("SELECT id FROM cold_boxes WHERE name='大冷藏箱'").fetchone()["id"]
    conn.close()

    # 1) FEFO：领 200 支，应先拿 F-A 的 80，再拿 F-B 的 120，过期批次不动
    r = app.create_requisition(site_id, vid, 200)
    assert r["allocated"] == 200 and r["shortage"] == 0
    assert [(i["batch_no"], i["quantity"]) for i in r["items"]] == [("F-A", 80), ("F-B", 120)], r["items"]
    did = r["dispatch_id"]
    print("[通过] FEFO 出库：先到期批次 F-A 先出，过期批次 F-OLD 未被动用")

    # 2) 冷藏箱限装：200 支 > 小箱 100，不放行；换大箱放行
    try:
        app.release_dispatch(did, small_box)
        raise AssertionError("超装不应放行")
    except app.ApiError as e:
        assert "不予放行" in e.message
        print(f"[通过] 超装拦截：{e.message}")
    app.release_dispatch(did, big_box)
    print("[通过] 换用限装 500 的大冷藏箱后放行，状态运输中")

    # 3) 温度正常 → 只记录；超标 → 自动作废并退回库存
    r = app.add_temperature(did, 5.0)
    assert r["excursion"] is False
    r = app.add_temperature(did, 12.5)
    assert r["voided"] is True
    conn = app.get_db()
    back = {row["batch_no"]: row["quantity"] for row in conn.execute("SELECT batch_no, quantity FROM batches")}
    assert back["F-A"] == 80 and back["F-B"] == 300, back   # 全部退回
    assert back["F-OLD"] == 500
    d = conn.execute("SELECT status, void_reason FROM dispatches WHERE id=?", (did,)).fetchone()
    assert d["status"] == "已作废" and "12.5" in d["void_reason"]
    disposals = conn.execute("SELECT * FROM disposals WHERE dispatch_id=?", (did,)).fetchall()
    assert len(disposals) == 2  # 两个批次各一条处置记录
    conn.close()
    print("[通过] 温度 12.5°C 超标：调拨单自动作废，200 支全部退回库存，生成 2 条处置记录")

    # 4) 作废单签收不了
    try:
        app.sign_dispatch(did)
        raise AssertionError("作废单不应能签收")
    except app.ApiError as e:
        assert "无法签收" in e.message
        print(f"[通过] 作废单签收被拒：{e.message}")

    # 5) 正常签收流程：再领一单 → 放行 → 温度正常 → 签收
    r2 = app.create_requisition(site_id, vid, 50)
    app.release_dispatch(r2["dispatch_id"], big_box)
    app.add_temperature(r2["dispatch_id"], 4.2)
    app.sign_dispatch(r2["dispatch_id"])
    conn = app.get_db()
    st = conn.execute("SELECT status FROM dispatches WHERE id=?", (r2["dispatch_id"],)).fetchone()["status"]
    conn.close()
    assert st == "已签收"
    print("[通过] 正常流程：领用 → 放行 → 温度正常 → 签收完成")

    # 6) 处置结果持久化：重开数据库连接（等价于重开页面/重启服务）仍可查
    conn = app.get_db()
    rows = conn.execute("SELECT * FROM disposals").fetchall()
    conn.close()
    assert len(rows) == 2
    print("[通过] 处置结果已持久化，重开连接仍可查询")


if __name__ == "__main__":
    test_concurrent_requisition()
    test_full_flow()
    print("\n全部测试通过。")

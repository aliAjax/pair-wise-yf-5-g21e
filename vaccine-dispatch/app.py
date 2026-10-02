#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""疫苗调拨台

疾控中心疫苗调拨管理：
- 接种点提交领用，即时按“先到期先出库(FEFO)”锁定批次，先到先得；
- 库存不足时如实反馈还差多少；
- 调拨单放行前校验冷藏箱限装数量，超装不放行；
- 运输途中登记温度，超出 2–8°C 冷链范围自动作废并退回库存；
- 已作废的调拨单接种点无法签收，处置结果持久保存可随时查询。

仅依赖 Python 标准库，数据存 SQLite 文件，重启不丢。
"""
import json
import os
import re
import sqlite3
import threading
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "vaccine_dispatch.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")

# 冷链温度范围（°C），超出即判超标
TEMP_MIN = 2.0
TEMP_MAX = 8.0

STATUS_PENDING = "待放行"
STATUS_TRANSIT = "运输中"
STATUS_SIGNED = "已签收"
STATUS_VOID = "已作废"

# 写操作串行化：保证“两个接种点同时提交，只有先到的拿到”
_db_lock = threading.Lock()


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS vaccines(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS batches(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vaccine_id INTEGER NOT NULL REFERENCES vaccines(id),
  batch_no TEXT NOT NULL,
  expiry_date TEXT NOT NULL,          -- YYYY-MM-DD
  quantity INTEGER NOT NULL CHECK(quantity >= 0),
  UNIQUE(vaccine_id, batch_no)
);
CREATE TABLE IF NOT EXISTS sites(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS cold_boxes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  capacity INTEGER NOT NULL           -- 限装数量（支）
);
CREATE TABLE IF NOT EXISTS dispatches(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  vaccine_id INTEGER NOT NULL REFERENCES vaccines(id),
  requested_qty INTEGER NOT NULL,     -- 申领数量
  allocated_qty INTEGER NOT NULL,     -- 实际锁批数量
  shortage_qty INTEGER NOT NULL,      -- 缺口数量
  status TEXT NOT NULL DEFAULT '待放行',
  cold_box_id INTEGER REFERENCES cold_boxes(id),
  created_at TEXT NOT NULL,
  released_at TEXT,
  signed_at TEXT,
  voided_at TEXT,
  void_reason TEXT
);
CREATE TABLE IF NOT EXISTS dispatch_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id INTEGER NOT NULL REFERENCES dispatches(id),
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  quantity INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS temperature_records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id INTEGER NOT NULL REFERENCES dispatches(id),
  temperature REAL NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS disposals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id INTEGER NOT NULL REFERENCES dispatches(id),
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  quantity INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""


def init_db():
    conn = get_db()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


def seed_db():
    """首次启动写入演示数据（已含一批过期疫苗，用于验证过期批次不参与出库）。"""
    conn = get_db()
    try:
        if conn.execute("SELECT COUNT(*) AS c FROM vaccines").fetchone()["c"]:
            return
        conn.executemany(
            "INSERT INTO vaccines(code, name) VALUES(?, ?)",
            [("HBV", "重组乙肝疫苗"), ("DTaP", "百白破疫苗"), ("MMR", "麻腮风疫苗")],
        )
        v = {r["code"]: r["id"] for r in conn.execute("SELECT id, code FROM vaccines")}
        conn.executemany(
            "INSERT INTO batches(vaccine_id, batch_no, expiry_date, quantity) VALUES(?,?,?,?)",
            [
                (v["HBV"], "HB2024099", "2026-09-15", 200),   # 已过期，不出库
                (v["HBV"], "HB2025101", "2026-11-30", 300),
                (v["HBV"], "HB2026042", "2027-03-31", 500),
                (v["HBV"], "HB2026077", "2027-06-30", 800),
                (v["DTaP"], "DP2025112", "2026-10-31", 200),
                (v["DTaP"], "DP2026031", "2027-02-28", 400),
                (v["MMR"], "MR2026015", "2027-01-31", 350),
            ],
        )
        conn.executemany(
            "INSERT INTO sites(name) VALUES(?)",
            [("城东接种点",), ("城西接种点",), ("临港接种点",), ("山北接种点",)],
        )
        conn.executemany(
            "INSERT INTO cold_boxes(name, capacity) VALUES(?,?)",
            [("1号冷藏箱", 240), ("2号冷藏箱", 600), ("3号冷藏箱", 1200)],
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------- 业务逻辑

def create_requisition(site_id, vaccine_id, quantity):
    """接种点提交领用：立即按效期 FEFO 锁批，库存不足如实报缺口。"""
    if not isinstance(quantity, int) or quantity <= 0:
        raise ApiError(400, "领用数量必须为正整数")
    with _db_lock:
        conn = get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            site = conn.execute("SELECT * FROM sites WHERE id=?", (site_id,)).fetchone()
            vaccine = conn.execute("SELECT * FROM vaccines WHERE id=?", (vaccine_id,)).fetchone()
            if not site:
                raise ApiError(404, "接种点不存在")
            if not vaccine:
                raise ApiError(404, "疫苗不存在")

            today = date.today().isoformat()
            batches = conn.execute(
                """SELECT * FROM batches
                   WHERE vaccine_id=? AND quantity>0 AND expiry_date>=?
                   ORDER BY expiry_date ASC, id ASC""",
                (vaccine_id, today),
            ).fetchall()

            remaining = quantity
            picked = []
            for b in batches:
                if remaining <= 0:
                    break
                take = min(b["quantity"], remaining)
                conn.execute("UPDATE batches SET quantity=quantity-? WHERE id=?", (take, b["id"]))
                picked.append({
                    "batch_no": b["batch_no"],
                    "expiry_date": b["expiry_date"],
                    "quantity": take,
                })
                remaining -= take

            allocated = quantity - remaining
            dispatch_id = None
            if allocated > 0:
                cur = conn.execute(
                    """INSERT INTO dispatches(site_id, vaccine_id, requested_qty, allocated_qty,
                                              shortage_qty, status, created_at)
                       VALUES(?,?,?,?,?,?,?)""",
                    (site_id, vaccine_id, quantity, allocated, remaining,
                     STATUS_PENDING, now_str()),
                )
                dispatch_id = cur.lastrowid
                batch_id_by_no = {
                    r["batch_no"]: r["id"]
                    for r in conn.execute("SELECT id, batch_no FROM batches WHERE vaccine_id=?", (vaccine_id,))
                }
                for p in picked:
                    conn.execute(
                        "INSERT INTO dispatch_items(dispatch_id, batch_id, quantity) VALUES(?,?,?)",
                        (dispatch_id, batch_id_by_no[p["batch_no"]], p["quantity"]),
                    )
            conn.commit()
            return {
                "dispatch_id": dispatch_id,
                "site": site["name"],
                "vaccine": vaccine["name"],
                "requested": quantity,
                "allocated": allocated,
                "shortage": remaining,
                "items": picked,
            }
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def release_dispatch(dispatch_id, cold_box_id):
    """放行：调拨量超出冷藏箱限装数量则不予放行。"""
    with _db_lock:
        conn = get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            d = conn.execute("SELECT * FROM dispatches WHERE id=?", (dispatch_id,)).fetchone()
            if not d:
                raise ApiError(404, "调拨单不存在")
            if d["status"] != STATUS_PENDING:
                raise ApiError(409, f"调拨单当前状态为「{d['status']}」，不能放行")
            box = conn.execute("SELECT * FROM cold_boxes WHERE id=?", (cold_box_id,)).fetchone()
            if not box:
                raise ApiError(404, "冷藏箱不存在")
            if d["allocated_qty"] > box["capacity"]:
                raise ApiError(
                    409,
                    f"调拨量 {d['allocated_qty']} 支超出{box['name']}限装 {box['capacity']} 支，不予放行",
                )
            conn.execute(
                "UPDATE dispatches SET status=?, cold_box_id=?, released_at=? WHERE id=?",
                (STATUS_TRANSIT, cold_box_id, now_str(), dispatch_id),
            )
            conn.commit()
            return {"ok": True, "status": STATUS_TRANSIT}
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def add_temperature(dispatch_id, temperature):
    """运输途中登记温度；超标则该单所涉批次自动作废并退回库存。"""
    try:
        temperature = float(temperature)
    except (TypeError, ValueError):
        raise ApiError(400, "温度必须为数字")
    with _db_lock:
        conn = get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            d = conn.execute("SELECT * FROM dispatches WHERE id=?", (dispatch_id,)).fetchone()
            if not d:
                raise ApiError(404, "调拨单不存在")
            if d["status"] != STATUS_TRANSIT:
                raise ApiError(409, f"仅「运输中」的调拨单可登记温度（当前：{d['status']}）")

            conn.execute(
                "INSERT INTO temperature_records(dispatch_id, temperature, recorded_at) VALUES(?,?,?)",
                (dispatch_id, temperature, now_str()),
            )

            excursion = temperature < TEMP_MIN or temperature > TEMP_MAX
            if excursion:
                items = conn.execute(
                    "SELECT * FROM dispatch_items WHERE dispatch_id=?", (dispatch_id,)
                ).fetchall()
                for it in items:
                    conn.execute(
                        "UPDATE batches SET quantity=quantity+? WHERE id=?",
                        (it["quantity"], it["batch_id"]),
                    )
                reason = f"运输温度 {temperature}°C 超出 {TEMP_MIN:.0f}–{TEMP_MAX:.0f}°C 冷链范围"
                conn.execute(
                    "UPDATE dispatches SET status=?, voided_at=?, void_reason=? WHERE id=?",
                    (STATUS_VOID, now_str(), reason, dispatch_id),
                )
                for it in items:
                    b = conn.execute(
                        """SELECT b.batch_no, v.name AS vname FROM batches b
                           JOIN vaccines v ON v.id=b.vaccine_id WHERE b.id=?""",
                        (it["batch_id"],),
                    ).fetchone()
                    conn.execute(
                        """INSERT INTO disposals(dispatch_id, batch_id, quantity, reason, detail, created_at)
                           VALUES(?,?,?,?,?,?)""",
                        (
                            dispatch_id,
                            it["batch_id"],
                            it["quantity"],
                            "运输温度超标",
                            f"{b['vname']} 批次 {b['batch_no']}：{reason}；调拨单作废，"
                            f"{it['quantity']} 支已退回库存，接种点不可签收",
                            now_str(),
                        ),
                    )
            conn.commit()
            return {"ok": True, "excursion": excursion, "voided": excursion}
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def sign_dispatch(dispatch_id):
    """接种点签收；已作废的单据签收不了。"""
    with _db_lock:
        conn = get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            d = conn.execute("SELECT * FROM dispatches WHERE id=?", (dispatch_id,)).fetchone()
            if not d:
                raise ApiError(404, "调拨单不存在")
            if d["status"] == STATUS_VOID:
                raise ApiError(409, "该调拨单已因冷链温度超标作废，接种点无法签收")
            if d["status"] == STATUS_SIGNED:
                raise ApiError(409, "该调拨单已签收，请勿重复操作")
            if d["status"] != STATUS_TRANSIT:
                raise ApiError(409, f"调拨单当前状态为「{d['status']}」，不能签收")
            conn.execute(
                "UPDATE dispatches SET status=?, signed_at=? WHERE id=?",
                (STATUS_SIGNED, now_str(), dispatch_id),
            )
            conn.commit()
            return {"ok": True, "status": STATUS_SIGNED}
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


# ---------------------------------------------------------------- 查询

def bootstrap():
    conn = get_db()
    try:
        return {
            "vaccines": [dict(r) for r in conn.execute("SELECT * FROM vaccines ORDER BY id")],
            "sites": [dict(r) for r in conn.execute("SELECT * FROM sites ORDER BY id")],
            "cold_boxes": [dict(r) for r in conn.execute("SELECT * FROM cold_boxes ORDER BY id")],
            "temp_range": [TEMP_MIN, TEMP_MAX],
        }
    finally:
        conn.close()


def list_inventory():
    conn = get_db()
    try:
        today = date.today().isoformat()
        rows = conn.execute(
            """SELECT b.id, v.name AS vaccine, b.batch_no, b.expiry_date, b.quantity
               FROM batches b JOIN vaccines v ON v.id=b.vaccine_id
               ORDER BY v.id, b.expiry_date, b.id"""
        ).fetchall()
        return [{**dict(r), "expired": r["expiry_date"] < today} for r in rows]
    finally:
        conn.close()


def list_dispatches():
    conn = get_db()
    try:
        ds = conn.execute(
            """SELECT d.*, s.name AS site, v.name AS vaccine, c.name AS box_name, c.capacity AS box_capacity
               FROM dispatches d
               JOIN sites s ON s.id=d.site_id
               JOIN vaccines v ON v.id=d.vaccine_id
               LEFT JOIN cold_boxes c ON c.id=d.cold_box_id
               ORDER BY d.id DESC"""
        ).fetchall()
        out = []
        for d in ds:
            items = conn.execute(
                """SELECT b.batch_no, b.expiry_date, i.quantity
                   FROM dispatch_items i JOIN batches b ON b.id=i.batch_id
                   WHERE i.dispatch_id=? ORDER BY b.expiry_date, b.id""",
                (d["id"],),
            ).fetchall()
            temps = conn.execute(
                "SELECT temperature, recorded_at FROM temperature_records WHERE dispatch_id=? ORDER BY id",
                (d["id"],),
            ).fetchall()
            out.append({
                **dict(d),
                "items": [dict(i) for i in items],
                "temperatures": [
                    {**dict(t), "excursion": not (TEMP_MIN <= t["temperature"] <= TEMP_MAX)}
                    for t in temps
                ],
            })
        return out
    finally:
        conn.close()


def list_disposals():
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT p.*, s.name AS site, v.name AS vaccine, b.batch_no, b.expiry_date
               FROM disposals p
               JOIN dispatches d ON d.id=p.dispatch_id
               JOIN sites s ON s.id=d.site_id
               JOIN batches b ON b.id=p.batch_id
               JOIN vaccines v ON v.id=b.vaccine_id
               ORDER BY p.id DESC"""
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "VaccineDispatch/1.0"

    def log_message(self, fmt, *args):
        pass  # 静默访问日志

    def _json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _static(self, filename):
        path = os.path.join(STATIC_DIR, filename)
        if not os.path.isfile(path):
            return self._json({"error": "页面不存在"}, 404)
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _handle(self, method):
        path = urlparse(self.path).path
        try:
            if method == "GET":
                if path in ("/", "/index.html"):
                    return self._static("index.html")
                if path == "/api/bootstrap":
                    return self._json(bootstrap())
                if path == "/api/inventory":
                    return self._json(list_inventory())
                if path == "/api/dispatches":
                    return self._json(list_dispatches())
                if path == "/api/disposals":
                    return self._json(list_disposals())
                raise ApiError(404, "接口不存在")

            body = self._body()
            if path == "/api/requisitions":
                return self._json(create_requisition(
                    int(body.get("site_id")), int(body.get("vaccine_id")), int(body.get("quantity"))
                ))
            m = re.fullmatch(r"/api/dispatches/(\d+)/(release|temperature|sign)", path)
            if m:
                did, action = int(m.group(1)), m.group(2)
                if action == "release":
                    return self._json(release_dispatch(did, int(body.get("cold_box_id"))))
                if action == "temperature":
                    return self._json(add_temperature(did, body.get("temperature")))
                return self._json(sign_dispatch(did))
            raise ApiError(404, "接口不存在")
        except ApiError as e:
            self._json({"error": e.message}, e.status)
        except (ValueError, TypeError):
            self._json({"error": "参数格式不正确"}, 400)
        except Exception as e:  # noqa: BLE001
            self._json({"error": f"服务器错误：{e}"}, 500)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")


def main():
    init_db()
    seed_db()
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"疫苗调拨台已启动：http://localhost:{port}")
    print(f"数据文件：{DB_PATH}（删除该文件可重置演示数据）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

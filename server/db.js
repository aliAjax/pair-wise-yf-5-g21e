// 数据库初始化与连接
// 使用 better-sqlite3（同步 API），领用/发运等关键操作放在事务里，
// 借助 SQLite 的写锁串行化并发请求，保证“先到先得”。
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'vaccine.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 8000');
db.pragma('foreign_keys = ON');

// 疫苗储运温度标准（℃）：2~8℃
const TEMP_MIN = 2;
const TEMP_MAX = 8;

db.exec(`
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS vaccines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vaccine_id INTEGER NOT NULL REFERENCES vaccines(id),
  batch_no TEXT NOT NULL,
  expiry_date TEXT NOT NULL,                 -- 效期（YYYY-MM-DD）
  quantity INTEGER NOT NULL,                -- 入库数量
  quantity_available INTEGER NOT NULL,      -- 可用库存（领用扣减 / 作废退回）
  status TEXT NOT NULL DEFAULT 'available', -- available | voided
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS cold_boxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  capacity INTEGER NOT NULL,                -- 冷藏箱限装数量
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS requisitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  vaccine_id INTEGER NOT NULL REFERENCES vaccines(id),
  quantity_requested INTEGER NOT NULL,      -- 申请数量
  quantity_allocated INTEGER NOT NULL DEFAULT 0, -- 实际领取数量
  quantity_shortfall INTEGER NOT NULL DEFAULT 0, -- 还差数量
  status TEXT NOT NULL DEFAULT 'pending',
  -- pending(待发运/部分领取) | in_transit(运输中) | signed(已签收) | voided(已作废)
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS requisition_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id INTEGER NOT NULL REFERENCES requisitions(id),
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  quantity INTEGER NOT NULL                 -- 从该批次领取的数量
);

CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id INTEGER NOT NULL REFERENCES requisitions(id),
  cold_box_id INTEGER NOT NULL REFERENCES cold_boxes(id),
  quantity INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_transit', -- in_transit | signed | voided
  temperature REAL,                          -- 最新温度
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS temperature_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id),
  temperature REAL NOT NULL,
  is_exceeded INTEGER NOT NULL DEFAULT 0,    -- 1=超标
  recorded_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS disposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id),
  requisition_id INTEGER NOT NULL REFERENCES requisitions(id),
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  vaccine_id INTEGER NOT NULL REFERENCES vaccines(id),
  quantity INTEGER NOT NULL,
  reason TEXT NOT NULL,                      -- 温度超标
  action TEXT NOT NULL,                      -- 作废并退回库存
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// 首次运行写入种子数据
function seed() {
  const siteCount = db.prepare('SELECT COUNT(*) c FROM sites').get().c;
  if (siteCount > 0) return;

  const insertSite = db.prepare('INSERT INTO sites (name) VALUES (?)');
  insertSite.run('城东接种点');
  insertSite.run('城西接种点');
  insertSite.run('城南接种点');

  const insertVaccine = db.prepare('INSERT INTO vaccines (name) VALUES (?)');
  const vacs = ['乙肝疫苗', '卡介苗', '脊髓灰质炎疫苗'];
  const vacId = {};
  for (const v of vacs) {
    const r = insertVaccine.run(v);
    vacId[v] = r.lastInsertRowid;
  }

  // 批次：故意设置不同效期，演示“先到期先出库(FEFO)”
  const insertBatch = db.prepare(
    'INSERT INTO batches (vaccine_id, batch_no, expiry_date, quantity, quantity_available) VALUES (?,?,?,?,?)'
  );
  // 乙肝疫苗：三个批次，效期分别为近/中/远
  insertBatch.run(vacId['乙肝疫苗'], 'Y2026-A01', '2026-11-30', 100, 100);
  insertBatch.run(vacId['乙肝疫苗'], 'Y2027-B02', '2027-03-15', 100, 100);
  insertBatch.run(vacId['乙肝疫苗'], 'Y2027-C03', '2027-09-20', 100, 100);
  // 卡介苗
  insertBatch.run(vacId['卡介苗'], 'K2026-05', '2026-12-31', 60, 60);
  insertBatch.run(vacId['卡介苗'], 'K2027-08', '2027-06-30', 60, 60);
  // 脊灰疫苗（库存偏少，便于演示抢占/短差）
  insertBatch.run(vacId['脊髓灰质炎疫苗'], 'J2026-02', '2026-10-31', 30, 30);
  insertBatch.run(vacId['脊髓灰质炎疫苗'], 'J2027-04', '2027-04-30', 30, 30);

  const insertBox = db.prepare('INSERT INTO cold_boxes (code, capacity) VALUES (?,?)');
  insertBox.run('冷藏箱 LQ-01', 50);
  insertBox.run('冷藏箱 LQ-02', 30);
  insertBox.run('冷藏箱 LQ-03', 20);
}

seed();

module.exports = { db, TEMP_MIN, TEMP_MAX };

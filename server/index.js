// 疫苗调拨台 - 服务入口
const path = require('path');
const express = require('express');
const { db, TEMP_MIN, TEMP_MAX } = require('./db');
const svc = require('./services');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const asyncHandler = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    const status = e.code === 'OVER_CAPACITY' || e.code === 'VOIDED' ? 409 : 400;
    res.status(status).json({ ok: false, error: e.message });
  }
};

// ---------- 基础数据 ----------
app.get('/api/sites', (req, res) => {
  res.json(db.prepare('SELECT id, name FROM sites ORDER BY id').all());
});
app.get('/api/vaccines', (req, res) => {
  res.json(db.prepare('SELECT id, name FROM vaccines ORDER BY id').all());
});
app.get('/api/cold-boxes', (req, res) => {
  const rows = db
    .prepare(
      `SELECT b.*,
              COALESCE((SELECT SUM(s.quantity) FROM shipments s
                         WHERE s.cold_box_id = b.id AND s.status = 'in_transit'), 0) AS loaded
       FROM cold_boxes b ORDER BY b.id`
    )
    .all();
  res.json(rows);
});

// ---------- 库存批次 ----------
app.get('/api/batches', (req, res) => {
  const rows = db
    .prepare(
      `SELECT b.id, b.batch_no, b.expiry_date, b.quantity, b.quantity_available, b.status,
              v.name AS vaccine_name, v.id AS vaccine_id
       FROM batches b JOIN vaccines v ON v.id = b.vaccine_id
       ORDER BY v.id, b.expiry_date ASC, b.id ASC`
    )
    .all();
  res.json(rows);
});
app.post('/api/batches', asyncHandler(async (req, res) => {
  const out = svc.addBatch(req.body || {});
  res.json({ ok: true, ...out });
}));

// ---------- 领用（提交即抢占批次） ----------
app.get('/api/requisitions', (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.*, s.name AS site_name, v.name AS vaccine_name
       FROM requisitions r
       JOIN sites s ON s.id = r.site_id
       JOIN vaccines v ON v.id = r.vaccine_id
       ORDER BY r.id DESC`
    )
    .all();
  const items = db
    .prepare(
      `SELECT ri.requisition_id, ri.quantity, b.batch_no, b.expiry_date
       FROM requisition_items ri JOIN batches b ON b.id = ri.batch_id
       ORDER BY ri.id`
    )
    .all();
  for (const r of rows) {
    r.items = items.filter((i) => i.requisition_id === r.id);
  }
  res.json(rows);
});
app.post('/api/requisitions', asyncHandler(async (req, res) => {
  const out = svc.claimStock(req.body || {});
  res.json({ ok: true, ...out });
}));

// 并发演示：两个接种点“同时”提交领用同一疫苗（脊灰疫苗库存 60），
// 数量故意设成只有一份能满足，用于演示先到先得、后到看差。
app.post('/api/demo/concurrent-claim', async (req, res) => {
  const { vaccineId, quantity } = req.body || {};
  const qty = quantity || 50;
  const sites = db.prepare('SELECT id, name FROM sites ORDER BY id LIMIT 2').all();
  if (sites.length < 2) return res.status(400).json({ ok: false, error: '需要至少两个接种点' });

  // 同时发出（不 await，让两个请求在事件循环里竞争）
  const p1 = fetch(`http://127.0.0.1:${PORT}/api/requisitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteId: sites[0].id, vaccineId, quantityRequested: qty }),
  }).then((r) => r.json());
  const p2 = fetch(`http://127.0.0.1:${PORT}/api/requisitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteId: sites[1].id, vaccineId, quantityRequested: qty }),
  }).then((r) => r.json());

  const [a, b] = await Promise.all([p1, p2]);
  res.json({ ok: true, results: [{ site: sites[0].name, ...a }, { site: sites[1].name, ...b }] });
});

// ---------- 发运（冷藏箱限装校验） ----------
app.get('/api/shipments', (req, res) => {
  const rows = db
    .prepare(
      `SELECT sh.*, cb.code AS cold_box_code, cb.capacity AS cold_box_capacity,
              r.site_id, r.vaccine_id, r.quantity_requested, r.quantity_shortfall,
              s.name AS site_name, v.name AS vaccine_name
       FROM shipments sh
       JOIN cold_boxes cb ON cb.id = sh.cold_box_id
       JOIN requisitions r ON r.id = sh.requisition_id
       JOIN sites s ON s.id = r.site_id
       JOIN vaccines v ON v.id = r.vaccine_id
       ORDER BY sh.id DESC`
    )
    .all();
  const logs = db
    .prepare('SELECT * FROM temperature_logs ORDER BY id DESC')
    .all();
  for (const sh of rows) {
    sh.temperatureLogs = logs.filter((l) => l.shipment_id === sh.id);
  }
  res.json(rows);
});
app.post('/api/shipments', asyncHandler(async (req, res) => {
  const out = svc.createShipment(req.body || {});
  res.json({ ok: true, ...out });
}));

// ---------- 温度记录 / 签收 ----------
app.post('/api/shipments/:id/temperature', asyncHandler(async (req, res) => {
  const out = svc.addTemperature({ shipmentId: Number(req.params.id), temperature: Number(req.body.temperature) });
  res.json({ ok: true, ...out });
}));
app.post('/api/shipments/:id/sign', asyncHandler(async (req, res) => {
  const out = svc.signShipment(Number(req.params.id));
  res.json({ ok: true, ...out });
}));

// ---------- 处置记录（作废退回，持久化，刷新可查） ----------
app.get('/api/disposals', (req, res) => {
  const rows = db
    .prepare(
      `SELECT d.*, b.batch_no, b.expiry_date, v.name AS vaccine_name,
              sh.id AS shipment_id, s.name AS site_name
       FROM disposals d
       JOIN batches b ON b.id = d.batch_id
       JOIN vaccines v ON v.id = d.vaccine_id
       JOIN shipments sh ON sh.id = d.shipment_id
       JOIN requisitions r ON r.id = d.requisition_id
       JOIN sites s ON s.id = r.site_id
       ORDER BY d.id DESC`
    )
    .all();
  res.json(rows);
});

app.get('/api/config', (req, res) => res.json({ tempMin: TEMP_MIN, tempMax: TEMP_MAX }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`疫苗调拨台已启动: http://localhost:${PORT}`);
});

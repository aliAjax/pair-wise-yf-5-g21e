// 核心业务逻辑
// 所有写操作都放在 db.exec('BEGIN IMMEDIATE') 事务中：
// better-sqlite3 为同步 API，事务执行期间不会被其它请求打断，
// 且 BEGIN IMMEDIATE 会立即获取写锁，从而保证并发领用“先到先得”。
const { db, TEMP_MIN, TEMP_MAX } = require('./db');

// ---------- 库存与批次 ----------

// 按疫苗查询可用批次，FEFO：效期先到期的先出库（效期升序，同效期按批次号）
function findAvailableBatches(vaccineId) {
  return db
    .prepare(
      `SELECT * FROM batches
       WHERE vaccine_id = ? AND status = 'available' AND quantity_available > 0
       ORDER BY expiry_date ASC, id ASC`
    )
    .all(vaccineId);
}

// 入库（新增批次）
function addBatch({ vaccineId, batchNo, expiryDate, quantity }) {
  const v = db.prepare('SELECT id FROM vaccines WHERE id = ?').get(vaccineId);
  if (!v) throw new Error('疫苗不存在');
  if (!batchNo || !expiryDate || !(quantity > 0)) {
    throw new Error('批次号、效期、数量(>0)不能为空');
  }
  const r = db
    .prepare(
      'INSERT INTO batches (vaccine_id, batch_no, expiry_date, quantity, quantity_available) VALUES (?,?,?,?,?)'
    )
    .run(vaccineId, batchNo, expiryDate, quantity, quantity);
  return { id: r.lastInsertRowid };
}

// ---------- 领用抢占（提交领用即领取批次） ----------

function claimStock({ siteId, vaccineId, quantityRequested }) {
  const site = db.prepare('SELECT id FROM sites WHERE id = ?').get(siteId);
  if (!site) throw new Error('接种点不存在');
  const vac = db.prepare('SELECT id, name FROM vaccines WHERE id = ?').get(vaccineId);
  if (!vac) throw new Error('疫苗不存在');
  if (!(quantityRequested > 0)) throw new Error('领用数量必须大于 0');

  db.exec('BEGIN IMMEDIATE');
  try {
    const batches = findAvailableBatches(vaccineId);
    let remaining = quantityRequested;
    const picked = []; // 从各批次领取的数量
    for (const b of batches) {
      if (remaining <= 0) break;
      const take = Math.min(b.quantity_available, remaining);
      picked.push({ batch: b, quantity: take });
      remaining -= take;
    }
    const allocated = quantityRequested - remaining; // 实际领到
    const shortfall = remaining; // 还差

    const r = db
      .prepare(
        `INSERT INTO requisitions
         (site_id, vaccine_id, quantity_requested, quantity_allocated, quantity_shortfall, status)
         VALUES (?,?,?,?,?, 'pending')`
      )
      .run(siteId, vaccineId, quantityRequested, allocated, shortfall);
    const requisitionId = r.lastInsertRowid;

    const insertItem = db.prepare(
      'INSERT INTO requisition_items (requisition_id, batch_id, quantity) VALUES (?,?,?)'
    );
    const dec = db.prepare(
      'UPDATE batches SET quantity_available = quantity_available - ? WHERE id = ?'
    );
    for (const p of picked) {
      insertItem.run(requisitionId, p.batch.id, p.quantity);
      dec.run(p.quantity, p.batch.id);
    }

    db.exec('COMMIT');
    return {
      requisitionId,
      vaccine: vac.name,
      allocated,
      shortfall,
      fullyAllocated: shortfall === 0,
      items: picked.map((p) => ({
        batchId: p.batch.id,
        batchNo: p.batch.batch_no,
        expiryDate: p.batch.expiry_date,
        quantity: p.quantity,
      })),
    };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 冷藏箱限装 & 发运 ----------

function createShipment({ requisitionId, coldBoxId }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const req = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(requisitionId);
    if (!req) throw new Error('调拨单不存在');
    if (req.status !== 'pending') {
      throw new Error(`当前状态不可发运（${req.status}），请先确认领用批次`);
    }
    if (req.quantity_allocated <= 0) {
      throw new Error('未领取到任何库存，不能发运');
    }
    const box = db.prepare('SELECT * FROM cold_boxes WHERE id = ?').get(coldBoxId);
    if (!box) throw new Error('冷藏箱不存在');

    // 该冷藏箱当前在途（in_transit）已装数量
    const loadRow = db
      .prepare(
        "SELECT COALESCE(SUM(quantity),0) AS c FROM shipments WHERE cold_box_id = ? AND status = 'in_transit'"
      )
      .get(coldBoxId);
    const currentLoad = loadRow.c;
    const qty = req.quantity_allocated;

    // 超出冷藏箱限装数量 → 不予放行
    if (currentLoad + qty > box.capacity) {
      const err = new Error(
        `超出冷藏箱限装数量，不予放行：冷藏箱 ${box.code} 限装 ${box.capacity}，` +
          `当前已装 ${currentLoad}，本单 ${qty}，合计将达 ${currentLoad + qty}`
      );
      err.code = 'OVER_CAPACITY';
      throw err;
    }

    const r = db
      .prepare(
        'INSERT INTO shipments (requisition_id, cold_box_id, quantity, status) VALUES (?,?,?,?)'
      )
      .run(requisitionId, coldBoxId, qty, 'in_transit');

    db.prepare("UPDATE requisitions SET status = 'in_transit' WHERE id = ?").run(requisitionId);

    db.exec('COMMIT');
    return { shipmentId: r.lastInsertRowid, quantity: qty, coldBox: box.code };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 运输温度记录：超标自动作废并退回库存 ----------

function voidShipmentAndReturn(shipment) {
  // shipment 为 shipments 行
  db.prepare("UPDATE shipments SET status = 'voided', updated_at = datetime('now','localtime') WHERE id = ?")
    .run(shipment.id);
  db.prepare("UPDATE requisitions SET status = 'voided' WHERE id = ?").run(shipment.requisition_id);

  const req = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(shipment.requisition_id);
  const items = db
    .prepare('SELECT * FROM requisition_items WHERE requisition_id = ?')
    .all(shipment.requisition_id);

  const insertDisposal = db.prepare(
    `INSERT INTO disposals
       (shipment_id, requisition_id, batch_id, vaccine_id, quantity, reason, action)
     VALUES (?,?,?,?,?,?,?)`
  );
  const ret = db.prepare(
    'UPDATE batches SET quantity_available = quantity_available + ? WHERE id = ?'
  );
  for (const it of items) {
    insertDisposal.run(
      shipment.id,
      shipment.requisition_id,
      it.batch_id,
      req.vaccine_id,
      it.quantity,
      '运输温度超标',
      '作废并退回库存'
    );
    ret.run(it.quantity, it.batch_id);
  }
}

function addTemperature({ shipmentId, temperature }) {
  if (typeof temperature !== 'number' || Number.isNaN(temperature)) {
    throw new Error('温度必须是数字');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const ship = db.prepare('SELECT * FROM shipments WHERE id = ?').get(shipmentId);
    if (!ship) throw new Error('发运单不存在');
    if (ship.status !== 'in_transit') {
      throw new Error(`当前状态不可记录温度（${ship.status}）`);
    }

    const exceeded = temperature < TEMP_MIN || temperature > TEMP_MAX;
    db.prepare(
      'INSERT INTO temperature_logs (shipment_id, temperature, is_exceeded) VALUES (?,?,?)'
    ).run(shipmentId, temperature, exceeded ? 1 : 0);
    db.prepare(
      "UPDATE shipments SET temperature = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(temperature, shipmentId);

    let voided = false;
    if (exceeded) {
      voidShipmentAndReturn(ship);
      voided = true;
    }

    db.exec('COMMIT');
    return { shipmentId, temperature, exceeded, voided };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 接种点签收 ----------

function signShipment(shipmentId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const ship = db.prepare('SELECT * FROM shipments WHERE id = ?').get(shipmentId);
    if (!ship) throw new Error('发运单不存在');
    if (ship.status === 'voided') {
      const err = new Error('该批次已作废，无法签收（运输温度超标）。处置结果可在“处置记录”中查看。');
      err.code = 'VOIDED';
      throw err;
    }
    if (ship.status !== 'in_transit') {
      throw new Error(`当前状态不可签收（${ship.status}）`);
    }
    db.prepare(
      "UPDATE shipments SET status = 'signed', updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(shipmentId);
    db.prepare("UPDATE requisitions SET status = 'signed' WHERE id = ?").run(ship.requisition_id);
    db.exec('COMMIT');
    return { shipmentId, status: 'signed' };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = {
  TEMP_MIN,
  TEMP_MAX,
  addBatch,
  claimStock,
  createShipment,
  addTemperature,
  signShipment,
};

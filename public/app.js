// 疫苗调拨台 前端逻辑
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const STATUS_LABEL = {
  pending: '待发运',
  in_transit: '运输中',
  signed: '已签收',
  voided: '已作废',
};
const BATCH_STATUS = { available: '可用', voided: '已作废' };

let CONFIG = { tempMin: 2, tempMax: 8 };

// ---------- 通用 ----------
function toast(msg, type = 'ok') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  setTimeout(() => (t.className = 'toast'), 2600);
}

async function api(url, opts) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function statusBadge(status, extra) {
  const label = extra || STATUS_LABEL[status] || status;
  return `<span class="badge ${status}">${esc(label)}</span>`;
}

// ---------- 页签 ----------
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.remove('active'));
    $$('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'shipment') loadShipments();
    if (btn.dataset.tab === 'disposal') loadDisposals();
  });
});

// ---------- 基础数据下拉 ----------
async function loadSites() {
  const sites = await api('/api/sites');
  $('#claim-site').innerHTML = sites
    .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`)
    .join('');
}
async function loadVaccines() {
  const vacs = await api('/api/vaccines');
  const opts = '<option value="">-- 请选择 --</option>' +
    vacs.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
  $('#batch-vaccine').innerHTML = opts;
  $('#claim-vaccine').innerHTML = opts;
}
async function loadBoxes() {
  const boxes = await api('/api/cold-boxes');
  $('#ship-box').innerHTML = boxes
    .map((b) => `<option value="${b.id}">${esc(b.code)}（限装${b.capacity}）</option>`)
    .join('');
  $('#boxes-body').innerHTML = boxes.map((b) => {
    const remain = b.capacity - b.loaded;
    return `<tr>
      <td>${esc(b.code)}</td>
      <td>${b.capacity}</td>
      <td>${b.loaded}</td>
      <td>${remain}</td>
    </tr>`;
  }).join('');
}

// ---------- 库存批次 ----------
async function loadBatches() {
  const rows = await api('/api/batches');
  $('#batches-body').innerHTML = rows.map((b) => {
    const expired = b.expiry_date < new Date().toISOString().slice(0, 10);
    return `<tr>
      <td>${esc(b.vaccine_name)}</td>
      <td>${esc(b.batch_no)}</td>
      <td>${esc(b.expiry_date)}${expired ? ' <span class="badge voided">已过期</span>' : ''}</td>
      <td>${b.quantity}</td>
      <td><strong>${b.quantity_available}</strong></td>
      <td><span class="badge ${b.status}">${BATCH_STATUS[b.status] || b.status}</span></td>
    </tr>`;
  }).join('');
}

$('#form-batch').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/api/batches', {
      method: 'POST',
      body: JSON.stringify({
        vaccineId: Number(fd.get('vaccineId')),
        batchNo: fd.get('batchNo'),
        expiryDate: fd.get('expiryDate'),
        quantity: Number(fd.get('quantity')),
      }),
    });
    e.target.reset();
    toast('入库成功');
    await Promise.all([loadBatches(), loadVaccines()]);
  } catch (err) {
    toast(err.message, 'err');
  }
});

// ---------- 领用 ----------
async function loadRequisitions() {
  const rows = await api('/api/requisitions');
  $('#requisitions-body').innerHTML = rows.map((r) => {
    const partial = r.quantity_shortfall > 0;
    const badge = r.status === 'pending' && partial
      ? statusBadge('pending', '部分领取')
      : statusBadge(r.status);
    const items = r.items.map((it) =>
      `${esc(it.batch_no)}(${it.expiry_date}) × ${it.quantity}`
    ).join('<br/>');
    return `<tr>
      <td>#${r.id}</td>
      <td>${esc(r.site_name)}</td>
      <td>${esc(r.vaccine_name)}</td>
      <td>${r.quantity_requested}</td>
      <td>${r.quantity_allocated}</td>
      <td>${r.quantity_shortfall > 0 ? `<strong style="color:#dc2626">${r.quantity_shortfall}</strong>` : 0}</td>
      <td style="font-size:12px">${items || '—'}</td>
      <td>${badge}</td>
      <td style="font-size:12px">${r.created_at}</td>
    </tr>`;
  }).join('');

  // 发运下拉：只列待发运且已领到库存的领用单
  const shippable = rows.filter((r) => r.status === 'pending' && r.quantity_allocated > 0);
  $('#ship-requisition').innerHTML = shippable.length
    ? shippable.map((r) => {
        const partial = r.quantity_shortfall > 0 ? `（还差${r.quantity_shortfall}）` : '';
        return `<option value="${r.id}">#${r.id} ${esc(r.site_name)} - ${esc(r.vaccine_name)} ×${r.quantity_allocated}${partial}</option>`;
      }).join('')
    : '<option value="">（无可发运领用单）</option>';
}

$('#form-claim').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const box = $('#claim-result');
  try {
    const out = await api('/api/requisitions', {
      method: 'POST',
      body: JSON.stringify({
        siteId: Number(fd.get('siteId')),
        vaccineId: Number(fd.get('vaccineId')),
        quantityRequested: Number(fd.get('quantityRequested')),
      }),
    });
    if (out.fullyAllocated) {
      box.innerHTML = `<div class="ok">✅ 领用成功：${esc(out.vaccine)} 申请 ${out.items.reduce((s, i) => s + i.quantity, 0)}，已按效期先出(FEFO)领取批次：<br/>${out.items.map((i) => `${esc(i.batchNo)}(${i.expiry_date}) × ${i.quantity}`).join('，')}</div>`;
    } else {
      box.innerHTML = `<div class="warn">⚠️ 库存不足：已领到 <strong>${out.allocated}</strong>，还差 <strong style="color:#dc2626">${out.shortfall}</strong>。<br/>已领批次：${out.items.map((i) => `${esc(i.batchNo)} × ${i.quantity}`).join('，') || '无'}</div>`;
    }
    toast(out.fullyAllocated ? '领用成功' : `部分领取，还差 ${out.shortfall}`);
    await Promise.all([loadRequisitions(), loadBatches()]);
  } catch (err) {
    box.innerHTML = `<div class="err">❌ ${esc(err.message)}</div>`;
    toast(err.message, 'err');
  }
});

// 并发演示
$('#btn-demo-concurrent').addEventListener('click', async () => {
  const box = $('#claim-result');
  box.innerHTML = '<div class="warn">⏳ 两个接种点同时提交领用中…</div>';
  try {
    const out = await api('/api/demo/concurrent-claim', {
      method: 'POST',
      body: JSON.stringify({ vaccineId: 3, quantity: 50 }), // 脊灰疫苗
    });
    box.innerHTML = out.results.map((r) => {
      if (r.error) return `<div class="err">${esc(r.site)}：❌ ${esc(r.error)}</div>`;
      if (r.fullyAllocated) {
        return `<div class="ok">${esc(r.site)}：✅ 先到先得，领取成功 ${r.allocated}（批次 ${r.items.map((i) => esc(i.batchNo)).join('、')}）</div>`;
      }
      return `<div class="warn">${esc(r.site)}：⚠️ 库存已被先提交的领完，领到 ${r.allocated}，还差 <strong style="color:#dc2626">${r.shortfall}</strong></div>`;
    }).join('');
    toast('并发演示完成');
    await Promise.all([loadRequisitions(), loadBatches()]);
  } catch (err) {
    box.innerHTML = `<div class="err">❌ ${esc(err.message)}</div>`;
  }
});

// ---------- 发运 ----------
$('#form-ship').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const box = $('#ship-result');
  try {
    const out = await api('/api/shipments', {
      method: 'POST',
      body: JSON.stringify({
        requisitionId: Number(fd.get('requisitionId')),
        coldBoxId: Number(fd.get('coldBoxId')),
      }),
    });
    box.innerHTML = `<div class="ok">✅ 已放行：发运单 #${out.shipmentId}，数量 ${out.quantity}，冷藏箱 ${esc(out.coldBox)}</div>`;
    toast('发运成功');
    await Promise.all([loadShipments(), loadBoxes(), loadRequisitions()]);
  } catch (err) {
    box.innerHTML = `<div class="err">❌ ${esc(err.message)}</div>`;
    toast('不予放行：超出冷藏箱限装', 'err');
  }
});

async function loadShipments() {
  const rows = await api('/api/shipments');
  const wrap = $('#shipments-list');
  if (!rows.length) {
    wrap.innerHTML = '<p class="hint">暂无发运单。</p>';
    return;
  }
  wrap.innerHTML = rows.map((sh) => {
    const cardCls = sh.status === 'voided' ? 'voided' : sh.status === 'signed' ? 'signed' : '';
    const logs = sh.temperatureLogs.map((l) => {
      const cls = l.is_exceeded ? 'log-bad' : 'log-ok';
      const mark = l.is_exceeded ? '❌超标' : '✓';
      return `<div class="${cls}">${esc(l.recorded_at)}　${l.temperature}℃　${mark}</div>`;
    }).join('');

    let actions = '';
    if (sh.status === 'in_transit') {
      actions = `
        <div class="temp-row">
          <input type="number" step="0.1" placeholder="输入温度℃" data-temp-input="${sh.id}" />
          <button class="btn small primary" data-btn-temp="${sh.id}">上传温度</button>
          <button class="btn small success" data-btn-sign="${sh.id}">签收</button>
        </div>`;
    } else if (sh.status === 'voided') {
      actions = `<div class="temp-row"><button class="btn small danger" data-btn-sign="${sh.id}" disabled>无法签收（已作废）</button></div>`;
    } else {
      actions = `<div class="temp-row"><span class="hint">该发运单已签收。</span></div>`;
    }

    return `<div class="ship-card ${cardCls}">
      <div class="ship-head">
        <strong>发运单 #${sh.id}</strong>
        ${statusBadge(sh.status)}
      </div>
      <div class="ship-meta">
        接种点：${esc(sh.site_name)}　疫苗：${esc(sh.vaccine_name)}　数量：${sh.quantity}<br/>
        冷藏箱：${esc(sh.cold_box_code)}（限装 ${sh.cold_box_capacity}）
        ${sh.temperature != null ? `　最新温度：${sh.temperature}℃` : ''}<br/>
        申请 ${sh.quantity_requested} / 已领 ${sh.quantity} / 还差 ${sh.quantity_shortfall}
      </div>
      <div class="temp-logs">${logs || '<span class="hint">暂无温度记录</span>'}</div>
      ${actions}
    </div>`;
  }).join('');

  // 绑定温度上传
  wrap.querySelectorAll('[data-btn-temp]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.btnTemp;
      const input = wrap.querySelector(`[data-temp-input="${id}"]`);
      const box = $('#ship-result');
      try {
        const out = await api(`/api/shipments/${id}/temperature`, {
          method: 'POST',
          body: JSON.stringify({ temperature: Number(input.value) }),
        });
        if (out.voided) {
          box.innerHTML = `<div class="err">🔥 温度 ${out.temperature}℃ 超标（标准 ${CONFIG.tempMin}~${CONFIG.tempMax}℃），该批疫苗已<strong>自动作废并退回库存</strong>，接种点无法签收。处置结果见“处置记录”。</div>`;
          toast('温度超标，已自动作废并退回库存', 'err');
        } else {
          box.innerHTML = `<div class="ok">✓ 温度 ${out.temperature}℃ 正常，已记录。</div>`;
          toast('温度已记录');
        }
        await Promise.all([loadShipments(), loadBatches(), loadDisposals()]);
      } catch (err) {
        box.innerHTML = `<div class="err">❌ ${esc(err.message)}</div>`;
        toast(err.message, 'err');
      }
    });
  });

  // 绑定签收
  wrap.querySelectorAll('[data-btn-sign]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.btnSign;
      const box = $('#ship-result');
      try {
        await api(`/api/shipments/${id}/sign`, { method: 'POST' });
        box.innerHTML = `<div class="ok">✅ 发运单 #${id} 已签收。</div>`;
        toast('签收成功');
        await loadShipments();
      } catch (err) {
        box.innerHTML = `<div class="err">❌ ${esc(err.message)}</div>`;
        toast(err.message, 'err');
      }
    });
  });
}

// ---------- 处置记录 ----------
async function loadDisposals() {
  const rows = await api('/api/disposals');
  $('#disposals-body').innerHTML = rows.length
    ? rows.map((d) => `<tr>
        <td style="font-size:12px">${d.created_at}</td>
        <td>${esc(d.site_name)}</td>
        <td>${esc(d.vaccine_name)}</td>
        <td>${esc(d.batch_no)}（${d.expiry_date}）</td>
        <td>${d.quantity}</td>
        <td><span class="badge voided">${esc(d.reason)}</span></td>
        <td>${esc(d.action)}</td>
        <td>#${d.shipment_id}</td>
      </tr>`).join('')
    : '<tr><td colspan="8" class="hint">暂无处置记录。</td></tr>';
}

// ---------- 初始化 ----------
async function init() {
  CONFIG = await api('/api/config');
  await Promise.all([loadSites(), loadVaccines(), loadBoxes(), loadBatches(), loadRequisitions()]);
}
init().catch((e) => toast(e.message, 'err'));

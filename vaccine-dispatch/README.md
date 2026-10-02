# 疫苗调拨台

疾控中心疫苗调拨管理小系统，替代"电话报数 + 人记批次和冷藏箱限装"的手工方式。
纯 Python 标准库实现（无需安装任何依赖），数据存 SQLite 文件，重启不丢。

## 运行

```bash
cd vaccine-dispatch
python3 app.py          # 默认 http://localhost:8000，PORT=9000 python3 app.py 可换端口
```

浏览器打开后四个页签：**领用申请 / 调拨单 / 库存与冷藏箱 / 处置记录**。
首次启动自动写入演示数据；删除 `vaccine_dispatch.db` 可重置。

## 业务规则

1. **提交领用即锁批**：接种点提交后系统立即按效期"先到期先出库（FEFO）"锁定批次并扣减库存，过期批次不参与出库。
2. **先到先得**：并发提交在数据库事务内串行处理，先到的先拿；库存不足时只锁现有部分，明确提示"还差多少支"。
3. **冷藏箱限装**：放行时必须选冷藏箱，调拨量超过限装数量不予放行（前端同时把装不下的箱子置灰）。
4. **温度超标自动作废**：运输中登记温度，超出 2–8°C 冷链范围时，该单所涉批次自动作废、数量退回库存，并生成处置记录。
5. **作废不可签收**：已作废的调拨单，接种点签收会被拒绝；处置结果持久保存，重开页面/重启服务仍可查。

## 验证

```bash
python3 test_flow.py    # 并发抢批 + FEFO + 限装拦截 + 超标作废 + 持久化，全部断言
```

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/bootstrap` | 疫苗、接种点、冷藏箱、冷链温度范围 |
| GET | `/api/inventory` | 库存批次（含是否过期） |
| GET | `/api/dispatches` | 调拨单列表（含批次明细、温度记录） |
| GET | `/api/disposals` | 处置记录 |
| POST | `/api/requisitions` | 提交领用 `{site_id, vaccine_id, quantity}` |
| POST | `/api/dispatches/{id}/release` | 放行 `{cold_box_id}`，超装返回 409 |
| POST | `/api/dispatches/{id}/temperature` | 登记温度 `{temperature}`，超标自动作废 |
| POST | `/api/dispatches/{id}/sign` | 接种点签收，作废单返回 409 |

调拨单状态流转：`待放行 → 运输中 → 已签收`，运输中温度超标转为 `已作废`。

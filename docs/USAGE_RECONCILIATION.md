# 用量覆盖与历史派生重算（0.1.2）

## 唯一计算入口

`core/usage.ts` 的 `reconcileUsage` 同时提供会话总量与 `usage_points`。汇总、趋势、明细和同步均消费这份派生结果。原始 `events` 保持不变。

- 逐响应按 provider、session、上游 response ID 去重；持久点 ID 使用这三个字段组成的 JSON 元组之 SHA-256，同一会话跨设备仍相同，独立会话不共享主键。缺少上游 ID 时只能按原始事件 ID 去重。相同数值不构成重复证据。
- 累计快照代表截至该检查点的累计值，先转换为相邻检查点增量；只有快照的历史仍保留。
- 响应位于检查点覆盖区间，或者与检查点属于同一 turn 时，可能描述相同用量。对关联覆盖区间保留逐响应值以及尚未被响应值代表的快照残差，不同时累加两份完整记录。
- 缺少准确的响应到快照关联 ID 时，混合覆盖结果是可观测下界；`usageUncertain` 为真，派生点带 `usageAllocationUncertain` 和 `usageBasis`。残差按检查点顺序稳定分配，其具体响应／日期归属不宣称精确。缓存和推理分别是 input、output 的子集，不另加进 total。
- 没有任何后续检查点、且属于明确不同 turn 的响应是新增用量，不能因数值相同删掉。
- 累计回退可能是重置或修正。没有明确证据时不虚构重置期间总量，以新的值为基线，仅计后续增加，并标不确定。适配器明确提供 `usageEpoch` 变化或 `counterReset:true` 才作为新计数段从零开始；现有日志不保证提供这些证据。
- fork 的继承响应不计入子任务。若保留了明确继承的累计检查点，则它可作为基线；若首个自身累计值可能含父任务历史而无基线，首值只建立基线、计后续增量及直接响应，标不确定。边界完全未知的继承历史继续排除。

这些规则不等同官方账单，也不提供每任务额度下降的精确归因。

## 派生重算与保护边界

`await store.recomputeDerived({ backup: true, force: false })` 使用 SQLite 一致性备份，再通过持久 `pending_projection` 对现存原始事件重新投影。调用者必须暂停采集和同步，通常在服务启动、启动采集前完成。成功记录 `derivedProjectionVersion=3`；普通重启无需重复计算。`force:true` 可重复执行。已经执行过派生版本 2 的数据库会再重算一次，修复早期未含 session 范围的响应点主键；数据库 schema 仍为 2。

仅重建 `sessions` 的可派生字段与 `usage_points`，并更新专用迁移标志／审计。备注、置顶、账号及时间绑定、设备／环境身份、源游标、授权、撤销／删除队列、outbox、同步状态和原始事件不清理。失败时保留待处理队列及同步暂停；重试成功恢复首次重算前的暂停状态。

状态投影新增 `state_at` 和 `state_observed_at`，区分状态发生与首次观察时间。SQLite `user_version` 从 1 升至 2；旧版程序会拒绝打开新版数据库，避免旧的隐式列写入破坏数据。降级必须同时恢复升级前的一致性备份。

已上传点沿用现有 SyncClient 的 CAS 修正：失效的旧快照点或旧响应主键修正为零，保留的点按新值纠正。旧响应主键纠正确认后再发送同会话的新主键，离线或多批同步期间可能短暂只看到部分修正，完成补传后收敛。重算本身不新增 outbox；重复同步不重复新增修正，已撤销的授权不会重新共享。中心真实行为由隔离 PostgreSQL 集成用例验收，不将单机结果当作双机验收。

## 隔离预检与应用

先退出 Monitor。使用当前构建的 Node 24+ 运行：

```powershell
# 默认只在一致性备份副本中迁移、重算两次，不修改原始数据库结构或统计。
node dist/scripts/recompute-derived.js --data-dir "<Monitor 数据目录>"

# 审查预检结果后，在原目录应用；仍先创建升级前一致性备份。
node dist/scripts/recompute-derived.js --data-dir "<Monitor 数据目录>" --apply
```

备份位于 `<数据目录>/backups/reliability-<时间戳>/monitor.sqlite`；使用 SQLite backup API 包含已提交 WAL 数据。并复制 Monitor 自己的 `hook-install.json`、`hook-enabled.json`（存在时）。配置、身份和授权等数据库设置已随数据库备份。

`report.json` 包含前后总量、完整派生投影两次重算是否一致、受保护表／设置／备注置顶 SHA-256 比对结果及 `integrity_check`。哈希不泄露原始正文。验收要求 `repeatEqual=true`、`protectedStateUnchanged=true`、完整性为 `ok`。特殊的旧库若原先尚未形成 session 投影，需要单独核对新增投影行，而不能仅以集合哈希判断丢失。

恢复时关闭 Monitor，保留故障数据库供诊断，将当前 `monitor.sqlite` 和同名 `-wal`／`-shm` 移到单独保存目录，再复制备份数据库为 `monitor.sqlite`，恢复同批配置文件。不要把旧 WAL 放到恢复数据库旁；不要清理 Codex 源日志或源数据库。降级需配套旧安装版本；新版本也可再次迁移该备份。

上述原始文件恢复仅适用于备份后没有新增撤销／删除授权的本机故障回滚。若之后发生共享撤销或中心删除，使用新版设置内的恢复流程，保留当前删除标记并重新配对授权，不能以旧库覆盖使权限复活。详见 [恢复与双机交接](SECOND_DEVICE.md)。

## 回归证据

- `tests/usage-repair.test.ts`：完整／部分覆盖、快照独有、顺序及重复投递、计数回退和明确重置、fork 基线、持久一致性、WAL 一致性备份、受保护数据、重算中断重试、schema 1→2。
- 公开个人服务的端到端测试位于 `packages/sync-service/test/integration.test.ts`，可独立运行；隔离测试不是双机实测。

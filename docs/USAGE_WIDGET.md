# 额度水球 · 0.2.0-candidate.7

小窗只显示账号剩余额度，不把本机 Token、上下文占用或 Agent 数量当作余额。任务、历史和 Agent 仍在完整监控台。

## 使用

- 从监控台总览、设置或托盘打开“用量浮窗”；也可安装独立的 AI Usage Window。
- 默认是置顶的透明水球。点击水球查看详情，长按约 0.35 秒后拖动；按住后球缘变亮。展开页选择账号及要放在水球中的额度窗口。
- “−／＋”调整大小，范围 70%–150%。水球原始尺寸 112×112 DIP，最小约 78×78；展开面板原始尺寸 340×420 DIP。位置、大小、关注额度和隐藏状态保存于本机。
- 水位表示所选窗口剩余百分比。前后两层水波及气泡只是视觉效果，不表示正在消耗额度。真实读数变化才改变水位。0% 是空球；未知、过期或读取失败显示问号和“待更新”。系统开启减少动态效果时停止动画，隐藏窗口时暂停动画。
- “始终置顶”默认开启；可手动选择开或关，重启沿用上次选择。也可隐藏到托盘。关闭小窗继续采集，托盘“退出并停止本产品采集”才退出整个共享进程。

## 数据来源

复用现有 `collector/quota.ts` 的只读 Codex app-server 查询：`account/rateLimits/read` 的 `usedPercent` 换算为剩余百分比，`resetsAt` 提供重置时间。没有返回值就显示未知，不从本机 Token 推算余额或重置时间。

可见时页面每 5 秒读取本机已有观察；隐藏时暂停页面轮询和事件订阅，再显示立即刷新，不停止后台采集；后台额度查询沿用原有节流和重试，不代表每 5 秒查询官方额度。查询失败保留来源和观察时间，但不把旧值当作当前余额。确认身份的同账号多设备观察取最新值而非相加；身份不足时按来源显示，不自动合并账号。

## 两种入口，一套采集

独立安装器由个人仓库的 `npm run package:widget` 生成，自带运行时；无需先安装完整监控台。其入口为 `desktop/widget-main.cjs`，复用既有 main、Store、额度查询、通知和托盘。可以打开完整个人监控台。

两种入口固定使用原来的 `ai-work-monitor` 用户数据目录，借助 Electron 单实例锁转交打开请求。不得复制数据库或设备凭据来连接另一台电脑。同机已有 Monitor 时须升级到支持浮窗的同版 candidate.7；candidate.5 不认识浮窗打开请求。个人 Monitor 与公司 Monitor 仍同机择一安装。

本轮不改数据结构、不重算历史、不修改 Codex 源文件。新增的 `usage-widget.json` 只保存窗口偏好。升级仍应先在原程序创建一致性备份，再正常退出。卸载独立浮窗不应删除共享监控数据；该行为还需最终安装器现场验证。

## 参考与复用

先检查现有额度、概览、启动鉴权、桌面单实例和托盘实现，直接复用，没有新增运行依赖。参考以下项目的交互或视觉模式，未复制其源码、图标或资源：

- [Clearelk/CodexQuota](https://github.com/Clearelk/CodexQuota/tree/11fa67d15ed1cf32968f5350fd1b4b5f8d8dbc93)，MIT：透明置顶小球、单独的详情层、大小和位置持久化。其 WPF 实现不能直接放入本项目 Electron/React。
- [ArloYi/Codex-Token-Monitor](https://github.com/ArloYi/Codex-Token-Monitor)，MIT：紧凑圆形额度与展开详情的层级，额度与本机 Token 分开。
- [ECharts LiquidFill](https://github.com/ecomfe/echarts-liquidfill/tree/45eb57694df70497172f29230108c692c46176fc)，该提交 `license.md` 为 BSD-3-Clause：分层波纹、相位、波幅和水位变化分别处理。其 package.json 许可字段与 license.md 不一致，本项目未引入包或改写其路径算法，只借鉴表现方式。实际水球使用已有 React、SVG 与 CSS。
- [Electron 45.1.0 窗口文档](https://github.com/electron/electron/blob/v45.1.0/docs/api/base-window.md)：透明无框窗口、置顶层级与程序调整边界。HTML 与 body 均透明，避免页面根背景形成黑方框。

## 验收边界

自动化和现场结果见 [本轮验收记录](WIDGET_ACCEPTANCE.md)。本页不是安装、真实双机或公司环境全部通过的证明。

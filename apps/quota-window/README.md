# AI 额度窗（纯余额独立版）0.1.0

仅显示当前 Codex 登录账号的剩余额度和源提供的重置时间。点击展开；长按拖动；支持选择额度窗口、置顶开/关、70%–150%大小与缩放、动态效果开/关、隐藏到托盘及退出。尊重系统减少动态效果设置。

独立产品标识 `local.ai.quota.window`，设置目录 `%APPDATA%/ai-quota-window`。默认置顶和动画开启，保存用户选择。不会读取或迁移 Monitor 的数据库、身份或配置；不创建 SQLite 数据库，不采集任务/Agent/Token历史，不同步、不含公司功能、没有完整监控台入口，也不启动本机 HTTP 服务。只在内存保留最新额度；退出即丢弃。设置文件损坏时保留原文件再恢复默认设置。

查询复用 Monitor 已有、注明 MIT 来源的额度协议实现，仅发送 initialize、account/read、account/rateLimits/read；禁用 Hooks，不请求 account/usage/read、任务接口、登录/刷新令牌或审批。不通过 Token 消耗估算余额。额度失败/超过三分钟/已到重置时间显示未知。后台每分钟尝试更新，失败退避；隐藏暂停页面更新，退出结束自身查询子进程。

需本机 Codex 已安装并登录；账号切换在 Codex 完成。本产品不处理登录或保存凭据，不保证读取所有订阅窗口。多个额度池/窗口分别显示，不相加。

## 构建

在个人仓库根目录安装依赖后：

```
node apps/quota-window/build.mjs
node apps/quota-window/build.mjs --package
```

安装器位于 `release/quota-only/AI.Quota.Window.Setup.0.1.0.exe`。显式文件清单只包含纯余额入口、额度协议、水球UI、图标及许可证。使用 Electron 自带运行时，不再捆绑 Monitor 的独立 Node 服务。旧的 AI Usage Window candidate.7 属于集成入口，不等于本产品。

## 验收边界

单元检查请求方法白名单、节流、并发查询合并、查询间账号变化、未知状态和进程清理；原监控台额度及浮窗回归需继续通过。打包边界检查与真正安装验收分别记录；不把开发窗口当成干净安装、升级、托盘退出或睡眠恢复的证明。

授权：个人项目 MIT；复用的 codex-usage-desktop MIT 声明保留，React / Electron 等第三方许可随包提供。

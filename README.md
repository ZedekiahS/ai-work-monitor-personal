# AI Work Monitor · 个人版

本地优先的中文 AI 工作监控，观察 Codex 额度、Token 用量、当前任务、主／子 Agent 和历史记录。保留搜索、回放、备注、置顶、账号与来源关联、通知、可选 Hooks、备份恢复、诊断、导出与 Windows 托盘。

本仓库包含完整个人客户端、可自建的本人同步服务、通用协议和透明员工连接器。公司后台、成员权限、跨员工统计和审计由独立私有公司仓库提供。本机个人功能不需要公司账号、PostgreSQL 或任何中心服务；加入公司仍须本人明确选择共享范围。

当前源码版本：`0.2.0-candidate.5`。源码拆分不改变已有设备身份、采集口径或本地数据。它仍是候选版本，真实双机、公司 HTTPS 部署、睡眠恢复和首次 Hooks 信任等现场验收尚未完整完成。

## 构建与运行

Windows x64，Node.js 24+：

```powershell
npm ci
npm run build
npm run typecheck:ui
npm test
npm run test:ui
npm run test:local-http
npm start
```

网页使用终端输出的完整本机启动链接，包含启动鉴权，请勿分享。默认仅监听 `127.0.0.1:4318`。开发运行 `npm run dev`；首次桌面运行先执行 `npm run desktop:prepare` 下载并校验锁定版本的 Electron，再执行 `npm run desktop`。Electron 45 的 npm 包不自动下载运行时。关闭窗口继续托盘采集，托盘“退出并停止本产品采集”才会停止本产品。

Windows 安装包：`npm run package:win`。打包需在 `AIWM_NODE_LICENSE` 指定与 Node 运行时同版本的官方 LICENSE；node.exe 同目录已有 LICENSE 时自动使用。缺失许可证会终止打包。未配置签名证书时生成未签名候选。不要把构建通过当成安装、升级或卸载的实际验收。

## 本人多电脑同步

自建 [本人同步服务](packages/sync-service/README.md) 需要 PostgreSQL 18、可信 HTTPS 和独立凭据。独立验证：

```powershell
npm run build:protocol
npm ci --prefix packages/sync-service
npm run build --prefix packages/sync-service
npm run test:personal-sync
```

根目录 `npm ci` 不会安装独立服务依赖。每台电脑独立安装、独立建立身份；不要复制另一台的数据库、配置或凭据。[第二设备步骤](docs/SECOND_DEVICE.md) 包含授权、断网补传、暂停、撤回和设备撤销。同步仅发送授权元数据，不发送完整对话、代码或 AI 登录凭据。

## 数据口径与边界

Token total = input + output，cached 和 reasoning 是子项，不是额外相加项。额度缺失显示未知；同账号多设备额度观察不相加。身份不足时不自动合并账号。没有状态证据的任务显示未知，日志静默不等于完成。

- [能力与限制](docs/CAPABILITIES.md)
- [用量归并](docs/USAGE_RECONCILIATION.md)
- [Hooks：默认关闭、首次信任由本人完成](docs/HOOKS.md)
- [隐私与共享](docs/PRIVACY_AND_SHARING.md)
- [历史补回与备份恢复](docs/HISTORY_RECOVERY.md)
- [本次源码拆分与验证](docs/REPOSITORY_SPLIT.md)

## 许可

项目自有个人组件采用 **MIT** 许可证，Copyright (c) 2026 ZedekiahS。完整条款见[LICENSE](LICENSE)。第三方许可独立生效，完整保留于 [第三方声明](THIRD_PARTY_NOTICES.md) 和 third_party/。

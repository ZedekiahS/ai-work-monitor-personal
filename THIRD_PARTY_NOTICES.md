# Third-party notices

核查日期：2026-10-26。

AI Work Monitor 采用独立领域模型，并局部复用 MIT 额度 RPC 实现。没有整体 fork，也没有把这些项目整体安装为运行依赖。本文件与 third_party 许可目录应随产品分发。

| 参考项目 | 核查提交 | 许可证据 | 本次使用 |
| --- | --- | --- | --- |
| itvincent-git/codex-usage-desktop | d7e04c43a7e1fe11c8dadee90908d70e19983569 | [MIT LICENSE](https://github.com/itvincent-git/codex-usage-desktop/blob/d7e04c43a7e1fe11c8dadee90908d70e19983569/LICENSE)，Copyright (c) 2026 vincent；清单一致 | 局部派生至 collector/quota.ts 与 tests/quota.test.ts，详见下节 |
| donvito/agent-monitor | 988a28fb9d5bb73597aaa80220a550eda05879dc | 所查提交树未找到项目许可文件；[package.json](https://github.com/donvito/agent-monitor/blob/988a28fb9d5bb73597aaa80220a550eda05879dc/package.json) 无 license | 设计阅读；未确认复用许可，不复制源码/素材 |
| Danielw412/AI-usage-tracker | 4a98ff5aed4cc2af62c27585fabdcc356b761e52 | 所查提交树未找到项目许可文件；[package.json](https://github.com/Danielw412/AI-usage-tracker/blob/4a98ff5aed4cc2af62c27585fabdcc356b761e52/package.json) 无 license | 设计阅读；未确认复用许可，不复制源码/素材 |
| capisoft-lib/codex_usage | 9a0650209d7cb2d76a7d9a1ee64cd0d2d63db929 | [GNU AGPL v3 LICENSE](https://github.com/capisoft-lib/codex_usage/blob/9a0650209d7cb2d76a7d9a1ee64cd0d2d63db929/LICENSE)，[package.json](https://github.com/capisoft-lib/codex_usage/blob/9a0650209d7cb2d76a7d9a1ee64cd0d2d63db929/package.json) 指定 AGPL-3.0-or-later | 设计阅读；未确定发布策略兼容，独立实现 |

这张表说明参考及实际复用范围，不宣称完整依赖审计已完成。AGPL 参考代码在发布策略兼容性确定之前不进入产品。

## MIT 实际派生范围与修改

- 上游固定 commit 的 src-tauri/src/codex_limits.rs:751–772,1192–1346,1384–1401：独立子进程、initialize/initialized、请求 ID 匹配、超时/结束和只读启动参数结构，移植至 collector/quota.ts。
- tests/quota.test.ts 的窗口测试参考上游 codex_limits.rs:1899–1963，另加身份、并发、错误脱敏、超时和账号切换断言。
- Copyright (c) 2026 vincent。完整原始许可保存在 [third_party/codex-usage-desktop-LICENSE](third_party/codex-usage-desktop-LICENSE)。派生源文件也含版权、固定版本及修改说明。
- 主要修改：Rust 转 TypeScript；限制输出且不保留 stderr；关闭 Hooks/MCP；只读账号请求、不刷新认证、不启动任务；多额度池与 null；稳定账号 ID 散列和未知账号隔离；同请求合并、持久节流退避。
- 未移植上游 OAuth/token 文件读取、私有网页接口、额度激活任务、重置消费、UI 素材或 Tauri 整个工程。
- 发布产物须携带本通知及完整 MIT 许可；仅仓库保留不等于安装包已保留。

## 产品依赖与发布条件

产品实际依赖的精确版本以本工程 lockfile 为准，不继承参考仓库全部依赖或其许可证。安装依赖后须保留各包自身 LICENSE/NOTICE；桌面分发需包含 Electron、Chromium、Node.js 及其第三方许可资源，不能仅携带本文件替代上游完整许可。

当前本文件对参考仓库的审查已完成；对最终桌面安装包中运行时/传递依赖的许可清单、原生二进制及所需 NOTICE 的完整核验，需随实际打包产物完成。尚无经过本文件确认的正式发布合规结论。该状态不阻止本地开发，但不能标记为“已完成发布许可审计”。

公开候选保留上述固定来源与原许可；最终依赖精确版本见各 package-lock.json。

## 2026-10-26 已安装依赖与安装包检查

已读取本工程 package-lock.json 及已安装包清单。当前生产依赖共17个，锁定版本如下；不以 package.json 中的版本范围代替实际版本。

| 包 | 实际版本 | 许可 |
| --- | --- | --- |
| react / react-dom / scheduler | 19.3.1 / 19.3.1 / 0.28.0 | MIT |
| pg / pg-cloudflare / pg-connection-string / pg-pool / pg-protocol | 8.23.1 / 1.4.1 / 2.14.1 / 3.14.0 / 1.16.1 | MIT |
| pg-types / pgpass | 2.2.0 / 1.0.5 | MIT；完整许可补在下方 |
| postgres-array / postgres-bytea / postgres-date / postgres-interval / xtend | 2.0.0 / 1.0.1 / 1.0.7 / 1.2.0 / 4.0.2 | MIT |
| pg-int8 / split2 | 1.0.1 / 4.2.0 | ISC |

工具/桌面运行时另核实：Electron 39.8.10（MIT，并自带 Chromium 第三方许可）、TypeScript 5.9.3（Apache-2.0）、Vite 7.3.7、tsx 4.23.15、electron-builder 26.18.0、@vitejs/plugin-react 5.2.0（后四项 MIT）。以上工具的完整传递依赖审计未冒充完成；本次重点是实际交付运行时与生产依赖许可资源。

首版 release/win-unpacked 实物检查结果：

- 根目录有 LICENSE.electron.txt、LICENSES.chromium.html。
- resources/runtime 有 NODE_LICENSE，与随包 node.exe 同目录。
- resources/app 有 THIRD_PARTY_NOTICES.md、third_party/codex-usage-desktop-LICENSE。
- 17个生产包均已打包，其中15个带自身 LICENSE/license 文件。
- pg-types 与 pgpass 的 MIT 全文在其上游 npm 包 README.md 中；打包时 README 被排除，因此把这两份完整许可补入本文件。来源分别为已安装 node_modules/pg-types/README.md 和 node_modules/pgpass/README.md。
- package.json 的 build.files 已含本通知与 third_party/**。**这些新增许可内容需随最终重建进入安装包**；首版安装包没有本段新增内容，最终包仍需检查。

这是一轮具体版本和产物的许可文件检查，不是对未来版本或全部发布事项的保证。以后更换依赖或锁文件，需重新生成清单和核对产物。

### pg-types 2.2.0 — full MIT license

The MIT License (MIT)

Copyright (c) 2014 Brian M. Carlson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

### pgpass 1.0.5 — full MIT license

Copyright (c) 2013-2016 Hannes Hörl

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.



## 0.2.0 候选拆分

上述 2026-10-26 表格是历史产物记录，不代表新包依赖。个人桌面已移除 pg 及其传递依赖，仅保留 React、React DOM、scheduler 与本项目公共协议。pg 仅在可独立部署的个人同步服务和私有企业服务中使用，仍保留上文原始许可。新候选 Electron 升级到 45.1.0，实际运行时、传递依赖、许可证文件见候选 DEPENDENCIES.json 和私有交付产物审计；不把历史检查冒充本轮实测。

## 2026-10-30 独立仓库许可

个人客户端、本人同步服务、公共协议和透明员工连接器的项目自有贡献，经权利人确认采用 MIT，版权署名 Copyright (c) 2026 ZedekiahS。原有第三方署名与许可不改变。公司目录与其专用后台、报表和管理代码不因个人组件采用 MIT 而开放许可。独立源仓库的精确依赖以本仓库锁文件与 DEPENDENCIES.json 为准；此前安装包记录仍是历史验证，不代表本次重新打包。

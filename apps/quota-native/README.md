# AI 额度窗 · 原生版 0.2.0-native.1

Windows 透明余额水球，只查询本机 Codex 当前登录的剩余额度和真实重置时间。点击展开，长按约350毫秒拖动；默认置顶，可关闭；支持70%–150%大小、动态开关、隐藏与托盘退出。

依赖 Windows x64、.NET Framework 4.8或更新的4.x系统运行环境，以及已安装登录的 Codex 原生程序。不捆绑运行时、Electron、浏览器或Node。不提供登录、账号切换、任务、历史、统计、同步或公司功能。账号操作请在 Codex 中完成。

只保存本产品窗口设置，目录为 `%APPDATA%/ai-quota-window-native`，与旧Electron版和Monitor隔离。余额只保存在内存，失败、超过三分钟或到达源重置时间显示未知。每分钟更新，失败退避。不读取或修改登录凭据，不估算余额，不把不同窗口相加。退出只结束自己启动的查询进程。

托盘双击显示，右键退出；关闭/隐藏窗口保留托盘。再次启动恢复已有窗口。尚无签名；候选不代表完整多设备、多DPI或睡眠现场验收。

## 构建

在仓库根目录：

```powershell
node apps/quota-native/build.mjs --test
node apps/quota-native/build.mjs --test --package --makensis '已有NSIS的makensis.exe完整路径'
```

沿用仓库Node构建调度，调用系统C#编译器、WPF程序集和NSIS，无NuGet/Rust依赖。产品运行不需要Node，构建工具不进入安装包。输出 `release/quota-native/0.2.0-native.1`。仅打包明确列出的EXE、设置运行环境声明、图标、说明与许可证。测试使用独立合成JSON-RPC子进程和临时设置目录。

安装器按当前用户安装，独立于旧Electron版。升级/卸载前从托盘退出本产品；卸载保留窗口设置，不触碰Monitor或Codex数据。便携版解压后运行 `AIQuotaWindow.exe`；也使用同一原生产品设置目录。恢复旧版可直接打开原有Electron入口，无数据库迁移。

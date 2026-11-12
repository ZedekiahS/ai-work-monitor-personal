const { app, ipcMain, Tray, Menu, nativeImage, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { createWidget } = require("./widget.cjs");
app.setName("ai-quota-window");
app.setAppUserModelId("local.ai.quota.window");
app.setPath(
  "userData",
  process.env.AIQW_USER_DATA_DIR ||
    path.join(app.getPath("appData"), "ai-quota-window"),
);
let widget,
  reader,
  tray,
  timer,
  quitting = false,
  exiting = false;
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
else {
  app.on("second-instance", () => {
    widget
      ?.show()
      .catch(() =>
        dialog.showErrorBox("额度窗", "窗口设置保存失败，请检查可用空间。"),
      );
  });
  app
    .whenReady()
    .then(async () => {
      const { createBalanceReader } = await import("./collector/quota-only.js");
      reader = createBalanceReader();
      const icon = path.join(__dirname, "icon.png");
      widget = createWidget({
        electron: require("electron"),
        userData: app.getPath("userData"),
        icon,
        pageUrl: pathToFileURL(path.join(__dirname, "ui/index.html")).href,
        monitor: () => null,
        isQuitting: () => quitting,
        reportError: (code) => {
          fs.mkdirSync(app.getPath("userData"), { recursive: true });
          fs.appendFileSync(
            path.join(app.getPath("userData"), "window-errors.log"),
            new Date().toISOString() + " " + code + "\n",
          );
        },
      });
      ipcMain.handle("aiqw-quota", async (event, action) => {
        if (!widget.trusted(event)) throw Error("页面无权查询额度");
        if (action === "state") return reader.state();
        if (action === "refresh") return reader.refresh();
        throw Error("未知操作");
      });
      tray = new Tray(
        nativeImage.createFromPath(icon).resize({ width: 32, height: 32 }),
      );
      tray.setToolTip("AI 额度窗");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          {
            label: "显示额度窗",
            click: () =>
              widget
                .show()
                .catch(() => dialog.showErrorBox("额度窗", "无法保存窗口设置")),
          },
          { label: "退出额度窗", click: () => app.quit() },
        ]),
      );
      tray.on("double-click", () =>
        widget
          .show()
          .catch(() => dialog.showErrorBox("额度窗", "无法保存窗口设置")),
      );
      await widget.show();
      void reader.refresh();
      timer = setInterval(() => void reader.refresh(), 60_000);
    })
    .catch(() => {
      dialog.showErrorBox(
        "额度窗未能启动",
        "请检查本机可用空间和应用设置目录，再重新打开。",
      );
      app.quit();
    });
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    quitting = true;
    if (exiting) return;
    event.preventDefault();
    exiting = true;
    clearInterval(timer);
    widget?.close();
    Promise.resolve(reader?.close()).finally(() => app.quit());
  });
}

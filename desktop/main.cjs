const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  Notification,
  shell,
  safeStorage,
  dialog,
} = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const net = require("node:net");
let win,
  tray,
  child,
  quitting = false;
const launchToken = crypto.randomBytes(32).toString("base64url");
let base = "";
let startupFailure = "",
  startupStage = "DESKTOP_STARTUP",
  collectorSpawnFailed = false;
function recordStartupFailure(code) {
  if (startupFailure) return;
  startupFailure = code;
  // Only internally selected codes are recorded. Never log child output,
  // environment values, commands, credential contents or exception messages.
  try {
    fs.appendFileSync(
      path.join(app.getPath("userData"), "desktop-startup.log"),
      `${new Date().toISOString()} ${code}\n`,
    );
  } catch {}
}
function showStartupFailure() {
  dialog.showErrorBox(
    "AI Work Monitor 未能启动",
    "本机监控服务未能启动。请关闭本产品后，从 Windows 开始菜单、桌面快捷方式或文件资源管理器重新打开。若仍无法启动，请联系支持并保留启动日志。监控记录和 Codex 会话已保留。",
  );
  app.quit();
}
// Give Windows an explicit identity instead of inheriting the launcher/Electron identity.
if (process.platform === "win32")
  app.setAppUserModelId("local.ai.work.monitor");
const appIcon = path.join(__dirname, "assets", "icon.ico");
if (process.env.AIWM_USER_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.AIWM_USER_DATA_DIR));
const ownsSingleInstanceLock = app.requestSingleInstanceLock();
if (!ownsSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(Number(process.env.AIWM_PORT || 4318), "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}
// quit() does not stop evaluating this module. Only the lock owner may
// register the ready callback that opens ports and starts the collector.
const ready = ownsSingleInstanceLock ? app.whenReady() : null;
ready
  ?.then(async () => {
    // This narrow guard covers the observed Codex Windows sandbox launcher.
    // It is not a general AppContainer detector or a security boundary.
    if (
      app.isPackaged &&
      process.platform === "win32" &&
      /[\\/]Packages[\\/]sandbox\.[^\\/]+[\\/]AC[\\/]?$/i.test(
        process.env.LOCALAPPDATA || "",
      )
    ) {
      dialog.showErrorBox(
        "请从正常 Windows 入口打开 AI Work Monitor",
        "检测到隔离启动环境，它可能看到不同的本地数据。已停止启动并保留原数据。请从开始菜单、桌面快捷方式或文件资源管理器打开 AI Work Monitor；不会自动覆盖或迁移数据库。",
      );
      app.quit();
      return;
    }
    startupStage = "LOCAL_PORT_UNAVAILABLE";
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const root = app.isPackaged
      ? app.getAppPath()
      : path.resolve(__dirname, "..");
    const runtime = app.isPackaged
      ? path.join(process.resourcesPath, "runtime", "node.exe")
      : process.env.AIWM_NODE_EXE || "node";
    const data = process.env.AIWM_DATA_DIR
      ? path.resolve(process.env.AIWM_DATA_DIR)
      : app.isPackaged
        ? path.join(app.getPath("userData"), "data")
        : path.join(root, ".data");
    startupStage = "DATA_DIRECTORY_UNAVAILABLE";
    fs.mkdirSync(data, { recursive: true });
    startupStage = "COLLECTOR_SPAWN_FAILED";
    child = spawn(runtime, [path.join(root, "dist", "server", "index.js")], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        ...process.env,
        AIWM_DATA_DIR: data,
        AIWM_PORT: String(port),
        AIWM_LAUNCH_TOKEN: launchToken,
        NODE_ENV: "production",
      },
    });
    child.on("error", (error) => {
      collectorSpawnFailed = true;
      recordStartupFailure(
        error?.code === "EACCES"
          ? "COLLECTOR_SPAWN_EACCES"
          : error?.code === "ENOENT"
            ? "COLLECTOR_RUNTIME_MISSING"
            : "COLLECTOR_SPAWN_FAILED",
      );
    });
    child.on("exit", () => {
      if (!quitting) recordStartupFailure("COLLECTOR_EXIT");
    });
    child.on("message", async (message) => {
      if (message?.type !== "credential-key-request") return;
      let credentialStage = "CREDENTIAL_STORAGE_UNAVAILABLE";
      try {
        if (!(await safeStorage.isAsyncEncryptionAvailable()))
          throw Error("storage-unavailable");
        const file = path.join(data, "credential-key.dpapi"),
          legacy = path.join(data, "credential-key.local");
        let encoded;
        if (fs.existsSync(file)) {
          credentialStage = "CREDENTIAL_DECRYPT_FAILED";
          const decoded = await safeStorage.decryptStringAsync(
            fs.readFileSync(file),
          );
          encoded = decoded.result;
          credentialStage = "CREDENTIAL_WRITE_FAILED";
          if (decoded.shouldReEncrypt)
            fs.writeFileSync(
              file,
              await safeStorage.encryptStringAsync(encoded),
            );
        } else {
          credentialStage = "CREDENTIAL_WRITE_FAILED";
          encoded = (
            fs.existsSync(legacy)
              ? fs.readFileSync(legacy)
              : crypto.randomBytes(32)
          ).toString("base64");
          const sealed = await safeStorage.encryptStringAsync(encoded);
          if ((await safeStorage.decryptStringAsync(sealed)).result !== encoded)
            throw Error("storage-roundtrip");
          fs.writeFileSync(file, sealed, { flag: "wx" });
          if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
        }
        credentialStage = "CREDENTIAL_IPC_FAILED";
        if (child?.connected)
          child.send({ type: "credential-key", key: encoded }, (error) => {
            if (error) recordStartupFailure("CREDENTIAL_IPC_FAILED");
          });
      } catch {
        recordStartupFailure(credentialStage);
        if (child?.connected)
          child.send({ type: "credential-key", key: null }, () => {});
      }
    });
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (startupFailure) break;
      try {
        const r = await fetch(base + "/api/settings", {
          headers: { Authorization: "Bearer " + launchToken },
          signal: AbortSignal.timeout(500),
        });
        if (r.ok && !startupFailure) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) {
      if (!startupFailure) recordStartupFailure("COLLECTOR_READY_TIMEOUT");
      showStartupFailure();
      return;
    }
    win = new BrowserWindow({
      width: 1440,
      height: 940,
      minWidth: 900,
      minHeight: 640,
      title: "AI Work Monitor",
      icon: appIcon,
      backgroundColor: "#0b1114",
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (
        /^https:\/\/(github\.com|learn\.chatgpt\.com|developers\.openai\.com)\//.test(
          url,
        )
      )
        void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== base) event.preventDefault();
    });
    win.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        win.hide();
      }
    });
    await win.loadURL(base + "/?launch=" + launchToken);
    const icon = nativeImage
      .createFromPath(path.join(__dirname, "assets", "icon.png"))
      .resize({ width: 32, height: 32 });
    tray = new Tray(icon);
    tray.setToolTip("AI Work Monitor · 关闭窗口后继续本机采集");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开监控台", click: () => win.show() },
        {
          label: "登录时启动（可选）",
          type: "checkbox",
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) =>
            app.setLoginItemSettings({ openAtLogin: item.checked }),
        },
        { type: "separator" },
        {
          label: "退出并停止本产品采集",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on("double-click", () => win.show());
    const shown = new Set();
    setInterval(async () => {
      try {
        const r = await fetch(base + "/api/notifications", {
          headers: { Authorization: "Bearer " + launchToken },
          signal: AbortSignal.timeout(1000),
        });
        if (!r.ok) return;
        const { items } = await r.json();
        for (const item of items) {
          if (shown.has(item.id)) continue;
          shown.add(item.id);
          if (Notification.isSupported()) {
            new Notification({ title: item.title, body: item.body }).show();
          }
          await fetch(
            base + "/api/notifications/" + encodeURIComponent(item.id) + "/ack",
            {
              method: "POST",
              headers: {
                Authorization: "Bearer " + launchToken,
                "Content-Type": "application/json",
              },
              body: "{}",
            },
          );
        }
      } catch {}
    }, 3000).unref();
  })
  .catch(() => {
    recordStartupFailure(startupStage);
    showStartupFailure();
  });
let collectorStopping = false;
app.on("before-quit", (event) => {
  quitting = true;
  if (
    child &&
    !collectorSpawnFailed &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    event.preventDefault();
    if (collectorStopping) return;
    collectorStopping = true;
    child.once("exit", () => {
      child = null;
      app.quit();
    });
    if (child.connected) child.send({ type: "shutdown" });
  }
});
app.on("window-all-closed", () => {});

const fs = require("node:fs");
const path = require("node:path");

const defaults = {
  visible: false,
  pinned: true,
  collapsed: true,
  scale: 1,
  quotaKey: "",
};
function validatePreferences(value) {
  const next = { ...defaults };
  if (typeof value?.scale === "number" && Number.isFinite(value.scale))
    next.scale = Math.max(0.7, Math.min(1.5, value.scale));
  for (const key of ["visible", "pinned", "collapsed"]) {
    if (typeof value[key] === "boolean") next[key] = value[key];
  }
  for (const key of ["quotaKey"]) {
    if (typeof value[key] === "string" && value[key].length <= 2048)
      next[key] = value[key];
  }
  if (Number.isFinite(value.x) && Number.isFinite(value.y)) {
    next.x = Math.round(value.x);
    next.y = Math.round(value.y);
  }
  return next;
}
function windowBounds(preferences, screen) {
  const scale = preferences.scale ?? 1;
  const width = Math.round((preferences.collapsed ? 112 : 340) * scale),
    height = Math.round((preferences.collapsed ? 112 : 420) * scale);
  const area = Number.isFinite(preferences.x)
    ? screen.getDisplayNearestPoint({ x: preferences.x, y: preferences.y })
        .workArea
    : screen.getPrimaryDisplay().workArea;
  return {
    width,
    height,
    x: Math.max(
      area.x,
      Math.min(
        preferences.x ?? area.x + area.width - width - 20,
        area.x + area.width - width,
      ),
    ),
    y: Math.max(
      area.y,
      Math.min(preferences.y ?? area.y + 20, area.y + area.height - height),
    ),
  };
}

function createWidget({
  electron,
  base,
  launchToken,
  userData,
  icon,
  monitor,
  showMonitor,
  isQuitting,
  reportError,
}) {
  const { BrowserWindow, ipcMain, screen } = electron;
  const file = path.join(userData, "usage-widget.json");
  let preferences = fs.existsSync(file)
    ? validatePreferences(JSON.parse(fs.readFileSync(file, "utf8")))
    : { ...defaults };
  let window = null;
  let moving = null;
  const save = (next) => {
    const validated = validatePreferences(next);
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(validated) + "\n");
    fs.renameSync(file + ".tmp", file);
    preferences = validated;
  };
  const state = () => ({ ...preferences });
  function persistPosition() {
    if (!window || window.isDestroyed()) return;
    const { x, y } = window.getBounds();
    try {
      save({ ...preferences, x, y });
    } catch {
      reportError("WIDGET_PREFERENCES_WRITE_FAILED");
      window.webContents.send(
        "aiwm-widget-error",
        "浮窗位置未保存，请检查本机可用空间。",
      );
    }
  }
  async function show() {
    save({ ...preferences, visible: true });
    if (!window || window.isDestroyed()) {
      window = new BrowserWindow({
        ...windowBounds(preferences, screen),
        title: "AI 额度水球",
        icon,
        frame: false,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: preferences.pinned,
        skipTaskbar: true,
        transparent: true,
        hasShadow: false,
        backgroundColor: "#00000000",
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => {
        if (new URL(url).origin !== base) event.preventDefault();
      });
      window.on("move", () => {
        clearTimeout(moving);
        moving = setTimeout(persistPosition, 350);
      });
      window.on("close", (event) => {
        if (!isQuitting()) {
          event.preventDefault();
          try {
            hide();
          } catch {
            reportError("WIDGET_PREFERENCES_WRITE_FAILED");
            window.webContents.send(
              "aiwm-widget-error",
              "隐藏设置未保存，请重试。",
            );
          }
        }
      });
      await window.loadURL(base + "/?view=widget&launch=" + launchToken);
    }
    window.show();
    window.setAlwaysOnTop(
      preferences.pinned,
      preferences.pinned ? "screen-saver" : "normal",
    );
    window.focus();
    return state();
  }
  function hide() {
    save({ ...preferences, visible: false });
    window?.hide();
    return state();
  }
  async function command(event, action, value) {
    // Only our authenticated local document's main frame may control desktop windows.
    if (
      ![window?.webContents, monitor()?.webContents].includes(event.sender) ||
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame ||
      new URL(event.senderFrame.url).origin !== base ||
      new URL(event.senderFrame.url).pathname !== "/"
    )
      throw Error("无法从此页面操作浮窗");
    switch (action) {
      case "state":
        return state();
      case "show":
        return show();
      case "hide":
        return hide();
      case "monitor":
        if (
          !["overview", "live", "accounts", "settings", "usage"].includes(value)
        )
          throw Error("未知页面");
        await showMonitor(value);
        return state();
      case "pinned":
      case "collapsed":
        if (typeof value !== "boolean") throw Error("无效的浮窗设置");
        save({ ...preferences, [action]: value });
        if (window && !window.isDestroyed()) {
          window.setAlwaysOnTop(
            preferences.pinned,
            preferences.pinned ? "screen-saver" : "normal",
          );
          window.setBounds(windowBounds(preferences, screen));
        }
        return state();
      case "quotaKey":
        if (typeof value !== "string" || value.length > 2048)
          throw Error("无效的选择");
        save({ ...preferences, [action]: value });
        return state();
      case "scale":
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < 0.7 ||
          value > 1.5
        )
          throw Error("无效的浮窗大小");
        save({ ...preferences, scale: value });
        if (window && !window.isDestroyed())
          window.setBounds(windowBounds(preferences, screen));
        return state();
      default:
        throw Error("未知的浮窗操作");
    }
  }
  ipcMain.handle("aiwm-widget", command);
  return {
    show,
    hide,
    state,
    close: () => {
      clearTimeout(moving);
      persistPosition();
    },
  };
}
module.exports = { createWidget, windowBounds, validatePreferences };

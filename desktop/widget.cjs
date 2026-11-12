const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const defaults = {
  visible: false,
  pinned: true,
  collapsed: true,
  scale: 1,
  quotaKey: "",
};
function validatePreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid widget preferences object");
  const next = { ...defaults };
  if (typeof value?.scale === "number" && Number.isFinite(value.scale))
    next.scale = Math.max(0.7, Math.min(1.5, value.scale));
  for (const key of ["visible", "pinned", "collapsed"]) {
    if (typeof value[key] === "boolean") next[key] = value[key];
  }
  if (typeof value.motion === "boolean") next.motion = value.motion;
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
  pageUrl,
}) {
  const { BrowserWindow, ipcMain, screen } = electron;
  const file = path.join(userData, "usage-widget.json");
  let preferences = { ...defaults };
  if (fs.existsSync(file)) {
    // Read errors are not corrupt JSON; never overwrite an unreadable file.
    const content = fs.readFileSync(file, "utf8");
    try {
      preferences = validatePreferences(JSON.parse(content));
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof TypeError))
        throw error;
      fs.renameSync(file, file + ".corrupt-" + randomUUID());
      reportError("WIDGET_PREFERENCES_RECOVERED");
    }
  }
  let window = null;
  let moving = null;
  let drag = null;
  const documentUrl = new URL(pageUrl || base + "/");
  const trusted = (event) =>
    [window?.webContents, monitor()?.webContents].includes(event.sender) &&
    event.senderFrame &&
    event.senderFrame === event.sender.mainFrame &&
    new URL(event.senderFrame.url).origin === documentUrl.origin &&
    new URL(event.senderFrame.url).pathname === documentUrl.pathname;
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
        const target = new URL(url);
        if (
          target.origin !== documentUrl.origin ||
          target.pathname !== documentUrl.pathname
        )
          event.preventDefault();
      });
      window.on("move", () => {
        clearTimeout(moving);
        moving = setTimeout(persistPosition, 350);
      });
      window.on("blur", () => {
        drag = null;
        persistPosition();
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
      await window.loadURL(
        pageUrl || base + "/?view=widget&launch=" + launchToken,
      );
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
    drag = null;
    save({ ...preferences, visible: false });
    window?.hide();
    return state();
  }
  async function command(event, action, value) {
    // Only our authenticated local document's main frame may control desktop windows.
    if (!trusted(event)) throw Error("无法从此页面操作浮窗");
    switch (action) {
      case "dragStart":
      case "dragMove":
      case "dragEnd": {
        if (
          !window ||
          event.sender !== window.webContents ||
          !preferences.collapsed
        )
          throw Error("请从水球拖动窗口");
        if (action === "dragStart") {
          drag = {
            cursor: screen.getCursorScreenPoint(),
            bounds: window.getBounds(),
          };
        } else if (action === "dragMove" && drag) {
          const point = screen.getCursorScreenPoint();
          window.setBounds(
            windowBounds(
              {
                ...preferences,
                x: drag.bounds.x + point.x - drag.cursor.x,
                y: drag.bounds.y + point.y - drag.cursor.y,
              },
              screen,
            ),
          );
        } else if (action === "dragEnd") {
          drag = null;
          clearTimeout(moving);
          persistPosition();
        }
        return state();
      }
      case "state":
        return state();
      case "show":
        return show();
      case "hide":
        return hide();
      case "monitor":
        if (!showMonitor) throw Error("此产品仅提供额度查询");
        if (
          !["overview", "live", "accounts", "settings", "usage"].includes(value)
        )
          throw Error("未知页面");
        await showMonitor(value);
        return state();
      case "pinned":
      case "collapsed":
      case "motion":
        if (typeof value !== "boolean") throw Error("无效的浮窗设置");
        drag = null;
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
    trusted,
    close: () => {
      drag = null;
      clearTimeout(moving);
      persistPosition();
    },
  };
}
module.exports = { createWidget, windowBounds, validatePreferences };

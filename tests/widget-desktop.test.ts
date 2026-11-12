import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
const { createWidget, windowBounds } = createRequire(import.meta.url)(
  "../desktop/widget.cjs",
);
const area = { x: 0, y: 0, width: 1280, height: 760 };
const screen = {
  getPrimaryDisplay: () => ({ workArea: area }),
  getDisplayNearestPoint: () => ({ workArea: area }),
};
test("widget returns to visible work area after monitor disconnect", () => {
  const bounds = windowBounds({ x: 4000, y: -300, collapsed: false }, screen);
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 1280);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 760);
});
test("native widget shares one window, persists choices, and rejects foreign and child frame commands", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwm-widget-native-"));
  const windows: any[] = [];
  let command: any;
  let opened = "";
  let quitting = false;
  class Window extends EventEmitter {
    webContents = {
      mainFrame: { url: "http://127.0.0.1:4318/?view=widget" },
      setWindowOpenHandler() {},
      on() {},
      send() {},
    };
    hidden = false;
    bounds: any;
    pinned: boolean;
    url = "";
    constructor(options: any) {
      super();
      this.bounds = options;
      this.pinned = options.alwaysOnTop;
      windows.push(this);
    }
    isDestroyed() {
      return false;
    }
    getBounds() {
      return this.bounds;
    }
    setBounds(b: any) {
      this.bounds = b;
    }
    level = "";
    setAlwaysOnTop(v: boolean, level: string) {
      this.pinned = v;
      this.level = level;
    }
    async loadURL(url: string) {
      this.url = url;
    }
    show() {
      this.hidden = false;
    }
    hide() {
      this.hidden = true;
    }
    focus() {}
  }
  try {
    const widget = createWidget({
      electron: {
        BrowserWindow: Window,
        screen,
        ipcMain: { handle: (_name: string, cb: any) => (command = cb) },
      },
      base: "http://127.0.0.1:4318",
      launchToken: "test-only",
      userData: dir,
      monitor: () => null,
      showMonitor: async (page: string) => {
        opened = page;
      },
      isQuitting: () => quitting,
      reportError: () => assert.fail("unexpected settings write failure"),
    });
    await widget.show();
    await widget.show();
    assert.equal(windows.length, 1);
    const w = windows[0];
    assert.equal(w.bounds.transparent, true);
    assert.equal(w.level, "screen-saver");
    const trusted = {
      sender: w.webContents,
      senderFrame: w.webContents.mainFrame,
    };
    await assert.rejects(
      command(
        { ...trusted, senderFrame: { url: "http://127.0.0.1:4318/" } },
        "hide",
      ),
    );
    w.webContents.mainFrame.url = "https://other.example/";
    await assert.rejects(command(trusted, "hide"));
    w.webContents.mainFrame.url = "http://127.0.0.1:4318/?view=widget";
    await assert.rejects(command(trusted, "pinned", "false"));
    await command(trusted, "pinned", false);
    assert.equal(w.pinned, false);
    await command(trusted, "collapsed", true);
    assert.equal(w.bounds.height, 112);
    await command(trusted, "scale", 0.7);
    assert.equal(w.bounds.width, 78);
    await assert.rejects(command(trusted, "scale", 0.1));
    await assert.rejects(command(trusted, "scale", Number.NaN));
    await command(trusted, "quotaKey", "source-specific-pool");
    await command(trusted, "monitor", "accounts");
    assert.equal(opened, "accounts");
    await assert.rejects(command(trusted, "monitor", "https://other.example"));
    let prevented = false;
    w.emit("close", {
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    assert.equal(w.hidden, true);
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, "usage-widget.json"), "utf8"),
    );
    assert.equal(saved.visible, false);
    assert.equal(saved.quotaKey, "source-specific-pool");
    assert.equal(saved.pinned, false);
    quitting = true;
    prevented = false;
    w.emit("close", {
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, false);
    widget.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

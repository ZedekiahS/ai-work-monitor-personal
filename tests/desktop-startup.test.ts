import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(
  new URL("../desktop/main.cjs", import.meta.url),
  "utf8",
);
const redirected =
  "C:\\Users\\tester\\AppData\\Local\\Packages\\sandbox.{12345678-1234-1234-1234-123456789abc}\\AC";
type Fault = "spawn" | "exit" | "credentials" | "none";

async function runStartup(
  options: {
    localAppData?: string;
    packaged?: boolean;
    platform?: string;
    fault?: Fault;
    ownsLock?: boolean;
    portOccupied?: boolean;
    secondInstance?: boolean;
    minimized?: boolean;
  } = {},
) {
  const actions: string[] = [];
  const errors: { title: string; message: string }[] = [];
  const writes: { file: string; value: string }[] = [];
  let readyRegistrations = 0;
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    exitCode: null as number | null,
    signalCode: null as string | null,
    send: (_message: unknown, callback?: (error: unknown) => void) =>
      callback?.(null),
  });
  const app = Object.assign(new EventEmitter(), {
    isPackaged: options.packaged ?? true,
    setAppUserModelId() {},
    setPath() {},
    requestSingleInstanceLock: () => options.ownsLock ?? true,
    getAppPath: () => "C:\\Product\\resources\\app",
    getPath: () => "C:\\Users\\tester\\AppData\\Roaming\\ai-work-monitor",
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings() {},
    quit: () => actions.push("quit"),
    whenReady: () => ({
      then(callback: () => Promise<void>) {
        readyRegistrations++;
        startup = Promise.resolve().then(callback);
        return startup;
      },
    }),
  });
  let startup: Promise<void> = Promise.resolve();
  class Window extends EventEmitter {
    webContents = { setWindowOpenHandler() {}, on() {} };
    constructor() {
      super();
      actions.push("window:new");
    }
    async loadURL() {
      actions.push("window:load");
    }
    show() {
      actions.push("window:show");
    }
    hide() {}
    focus() {
      actions.push("window:focus");
    }
    isMinimized() {
      return options.minimized ?? false;
    }
    restore() {
      actions.push("window:restore");
    }
  }
  class Tray extends EventEmitter {
    constructor() {
      super();
      actions.push("tray:new");
    }
    setToolTip() {}
    setContextMenu() {}
  }
  const mockedFs = {
    mkdirSync: () => actions.push("fs:mkdir"),
    existsSync: (file: string) =>
      options.fault === "credentials" && file.endsWith("credential-key.dpapi"),
    readFileSync: () => {
      actions.push("fs:read");
      return Buffer.from("PRIVATE_CIPHERTEXT_DO_NOT_LOG");
    },
    writeFileSync: (file: string, value: unknown) =>
      writes.push({ file, value: String(value) }),
    appendFileSync: (file: string, value: unknown) =>
      writes.push({ file, value: String(value) }),
    unlinkSync: () => actions.push("fs:unlink"),
  };
  let faultDelivered = false;
  const context = {
    require(name: string) {
      if (name === "electron")
        return {
          app,
          BrowserWindow: Window,
          Tray,
          Menu: { buildFromTemplate: (items: unknown) => items },
          nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
          Notification: { isSupported: () => false },
          shell: { openExternal() {} },
          dialog: {
            showErrorBox: (title: string, message: string) =>
              errors.push({ title, message }),
          },
          safeStorage: {
            isAsyncEncryptionAvailable: async () => true,
            decryptStringAsync: async () => {
              throw new Error("PRIVATE_CREDENTIAL_ERROR_DO_NOT_LOG");
            },
            encryptStringAsync: async () => Buffer.from("sealed"),
          },
        };
      if (name === "node:child_process")
        return {
          spawn: () => {
            actions.push("spawn");
            return child;
          },
        };
      if (name === "node:net")
        return {
          createServer: () => {
            actions.push("net:create");
            return {
              listen: (_port: number, _host: string, callback: () => void) => {
                actions.push("net:listen");
                if (!options.portOccupied) callback();
              },
              address: () => ({ port: 4318 }),
              close: (callback: () => void) => callback(),
              on(event: string, callback: (error: Error) => void) {
                if (event === "error" && options.portOccupied)
                  queueMicrotask(() =>
                    callback(
                      Object.assign(new Error("fixture port occupied"), {
                        code: "EADDRINUSE",
                      }),
                    ),
                  );
              },
            };
          },
        };
      if (name === "node:fs") return mockedFs;
      if (name === "node:path") return path.win32;
      if (name === "node:crypto") return crypto;
      throw new Error("Unexpected import " + name);
    },
    process: {
      platform: options.platform ?? "win32",
      resourcesPath: "C:\\Product\\resources",
      env: {
        LOCALAPPDATA:
          options.localAppData ?? "C:\\Users\\tester\\AppData\\Local",
        PRIVATE_ENV_DO_NOT_LOG: "PRIVATE_SECRET_DO_NOT_LOG",
      },
    },
    __dirname: "C:\\Product\\resources\\app\\desktop",
    Buffer,
    URL,
    AbortSignal,
    Date,
    console,
    setTimeout: (callback: () => void) => {
      queueMicrotask(callback);
      return 0;
    },
    clearTimeout() {},
    setInterval: () => ({ unref() {} }),
    async fetch() {
      actions.push("fetch");
      if (!faultDelivered && options.fault && options.fault !== "none") {
        faultDelivered = true;
        if (options.fault === "spawn")
          child.emit(
            "error",
            Object.assign(new Error("PRIVATE_SPAWN_COMMAND_DO_NOT_LOG"), {
              code: "EACCES",
            }),
          );
        if (options.fault === "exit") {
          child.exitCode = 7;
          child.connected = false;
          child.emit("exit", 7, null);
        }
        if (options.fault === "credentials")
          child.emit("message", { type: "credential-key-request" });
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      return {
        ok: !options.fault || options.fault === "none",
        json: async () => ({ items: [] }),
      };
    },
  };
  vm.runInNewContext(source, context, { filename: "desktop/main.cjs" });
  // main.cjs handles rejected startup promises in its own catch; let that run
  // before inspecting the outcome instead of treating it as a harness error.
  await startup.catch(() => {});
  await Promise.resolve();
  if (options.secondInstance) app.emit("second-instance");
  return { actions, errors, writes, readyRegistrations };
}

for (const portOccupied of [false, true]) {
  test(`duplicate launch with ${portOccupied ? "occupied" : "free"} port quits without scheduling startup or touching collector data`, async () => {
    const result = await runStartup({ ownsLock: false, portOccupied });
    assert.deepEqual(result.actions, ["quit"]);
    assert.equal(result.readyRegistrations, 0);
    assert.equal(result.writes.length, 0);
    assert.equal(result.errors.length, 0);
  });
}

for (const minimized of [false, true]) {
  test(`existing ${minimized ? "minimized" : "visible"} window receives second-instance and regains focus`, async () => {
    const result = await runStartup({ secondInstance: true, minimized });
    assert.equal(result.readyRegistrations, 1);
    assert.equal(result.actions.filter((v) => v === "spawn").length, 1);
    assert.equal(result.actions.filter((v) => v === "window:new").length, 1);
    assert.equal(result.actions.filter((v) => v === "tray:new").length, 1);
    assert.deepEqual(
      result.actions.filter((v) =>
        ["window:restore", "window:show", "window:focus"].includes(v),
      ),
      minimized
        ? ["window:restore", "window:show", "window:focus"]
        : ["window:show", "window:focus"],
    );
    assert.equal(result.errors.length, 0);
  });
}

test("packaged Windows sandbox entry stops before any port, data or collector operation", async () => {
  const result = await runStartup({ localAppData: redirected });
  assert.deepEqual(
    result.actions,
    ["quit"],
    "must not open a port, create data, spawn or load a window",
  );
  assert.equal(result.writes.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /隔离/);
  assert.match(result.errors[0].message, /开始菜单|桌面|文件资源管理器/);
  assert.match(result.errors[0].message, /保留/);
});

test("ordinary user, other packages, development and non-Windows entries retain normal ready flow", async () => {
  for (const options of [
    {},
    {
      localAppData:
        "C:\\Users\\tester\\AppData\\Local\\Packages\\Microsoft.Example\\AC",
    },
    {
      localAppData:
        "C:\\Users\\tester\\AppData\\Local\\Packages\\sandbox.demo\\LocalCache",
    },
    { localAppData: redirected, packaged: false },
    { localAppData: redirected, platform: "darwin" },
  ]) {
    const result = await runStartup(options);
    assert.equal(result.errors.length, 0, JSON.stringify(options));
    assert.ok(result.actions.includes("net:listen"));
    assert.ok(result.actions.includes("spawn"));
    assert.ok(result.actions.includes("window:load"));
  }
});

for (const [fault, code] of [
  ["spawn", "COLLECTOR_SPAWN_EACCES"],
  ["exit", "COLLECTOR_EXIT"],
  ["credentials", "CREDENTIAL_DECRYPT_FAILED"],
] as const) {
  test(`startup ${fault} failure gives a customer action and keeps a safe code only in diagnostics`, async () => {
    const result = await runStartup({ fault });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /本机监控服务未能启动.*联系支持/);
    assert.doesNotMatch(result.errors[0].message, new RegExp(code));
    assert.ok(!result.actions.includes("window:load"));
    const diagnostics = result.writes
      .filter((v) => v.file.endsWith("desktop-startup.log"))
      .map((v) => v.value)
      .join("\n");
    assert.match(diagnostics, new RegExp(code));
    assert.doesNotMatch(
      diagnostics + result.errors[0].message,
      /PRIVATE_|Bearer|AIWM_LAUNCH_TOKEN|credential-key\.dpapi/,
    );
    assert.ok(
      result.actions.filter((v) => v === "fetch").length < 150,
      "failures must not wait for the entire generic timeout",
    );
  });
}

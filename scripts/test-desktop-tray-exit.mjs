// Integration test of the actual packaged Tray menu callback, not a UI click test.
// No direct app.quit(), process termination, mocked Electron, or replacement menu.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const executable = path.resolve(process.argv[2] || 'release/win-unpacked/AI Work Monitor.exe');
const reportPath = path.resolve(process.argv[3] || 'work/tray-exit-result.json');
const tracePath = reportPath.replace(/\.json$/, '') + '-events.jsonl';
const port = Number(process.env.AIWM_PORT || 4318);
const fixture = reportPath.replace(/\.json$/, '') + '-fixture';
fs.mkdirSync(path.join(fixture, 'source'), {recursive:true});
const exitLabel = '退出并停止本产品采集';
const started = Date.now();
const report = { startedAt: new Date().toISOString(), executable, port, method: 'actual Tray MenuItem.click integration', passed: false };
const log = (stage, details = {}) => console.log(JSON.stringify({ stage, elapsedMs: Date.now() - started, ...details }));
const exec = promisify(execFile);
async function processes() {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"], { windowsHide: true });
  const rows = JSON.parse(stdout || '[]');
  return Array.isArray(rows) ? rows : [rows];
}
function descendants(rows, root) {
  const ids = new Set([root]);
  for (let last = -1; last !== ids.size;) {
    last = ids.size;
    for (const row of rows) if (ids.has(row.ParentProcessId)) ids.add(row.ProcessId);
  }
  return rows.filter(row => ids.has(row.ProcessId));
}
function listening() {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(800);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}
async function until(check, ms, message) {
  const end = Date.now() + ms;
  do { const value = await check(); if (value) return value; await delay(150); } while (Date.now() < end);
  throw Error(message);
}
let appProcess, ws, send, paused;
const waiters = new Map();
try {
  assert.equal(await listening(), false, 'Port already occupied; existing process left untouched');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(tracePath, '');
  let inspectorUrl, appExited = false;
  appProcess = spawn(executable, ['--inspect-brk=127.0.0.1:0'], {
    cwd: path.dirname(executable), windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, AIWM_PORT:String(port), AIWM_DATA_DIR:path.join(fixture,'data'), AIWM_USER_DATA_DIR:path.join(fixture,'desktop'), CODEX_HOME:path.join(fixture,'source'), AIWM_QUOTA_DISABLED:'1'},
  });
  report.appPid = appProcess.pid;
  appProcess.once('error', error => { report.launchError = error.code; });
  appProcess.once('exit', (code, signal) => {
    appExited = true; report.exitCode = code; report.exitSignal = signal; report.exitedAt = new Date().toISOString();
  });
  // Only retain the loopback debugger endpoint; discard all application output.
  appProcess.stdout.on('data', () => {});
  appProcess.stderr.on('data', chunk => {
    const match = chunk.toString().match(/ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/);
    if (match) inspectorUrl = match[0];
  });
  await until(() => inspectorUrl, 10000, 'No local Electron inspector endpoint');
  ws = new WebSocket(inspectorUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Debugger.paused') paused = message.params;
    if (message.method === 'Debugger.resumed') paused = null;
    const waiter = waiters.get(message.id);
    if (waiter) { clearTimeout(waiter.timer); waiters.delete(message.id); message.error ? waiter.reject(Error(message.error.message)) : waiter.resolve(message.result); }
  });
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { waiters.delete(id); reject(Error('Inspector request timed out: ' + method)); }, 10000);
    waiters.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable'); await send('Debugger.enable');
  await send('Runtime.runIfWaitingForDebugger');
  await until(() => paused, 10000, 'No initial main-process breakpoint');
  const hook = `(() => {
    const electron = require('electron'), cp = require('node:child_process'), fs = require('node:fs');
    const p = globalThis.__aiwmTrayExitTest = { menu: null, tray: null, collector: null };
    const mark = (event, details = {}) => fs.appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ event, at: new Date().toISOString(), ...details }) + '\\n');
    p.mark = mark;
    const originalSpawn = cp.spawn;
    cp.spawn = function(exe, args, options) {
      const child = originalSpawn.call(this, exe, args, options);
      if (args?.[0]?.replaceAll('\\\\', '/').endsWith('/dist/server/index.js')) {
        p.collector = child; cp.spawn = originalSpawn;
        child.on('message', message => { if(message?.type === 'shutdown-complete') mark('collector-graceful-shutdown'); });
        child.on('exit', code => mark('collector-exit', {code}));
        mark('collector-spawn', { pid: child.pid });
      }
      return child;
    };
    const originalMenu = electron.Tray.prototype.setContextMenu;
    electron.Tray.prototype.setContextMenu = function(menu) {
      const result = originalMenu.call(this, menu);
      if (menu?.items.some(item => item.label === ${JSON.stringify(exitLabel)})) {
        p.tray = this; p.menu = menu; electron.Tray.prototype.setContextMenu = originalMenu;
        mark('actual-tray-menu-attached', { labels: menu.items.map(item => item.label) });
      }
      return result;
    };
    electron.app.on('before-quit', () => mark('before-quit'));
    electron.app.on('will-quit', () => mark('will-quit'));
    electron.app.on('quit', (_, code) => mark('quit', { code }));
    p.electron = electron;
    return 'observers-installed';
  })()`;
  const installed = await send('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId, expression: hook, returnByValue: true });
  assert.equal(installed.result?.value, 'observers-installed', JSON.stringify(installed.exceptionDetails));
  await send('Debugger.resume');
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw Error('Test observer evaluation failed: ' + result.exceptionDetails.text);
    return result.result.value;
  };
  report.runtime = await until(() => evaluate(`(() => { const p = globalThis.__aiwmTrayExitTest;
    return p?.menu && p.collector && { version: p.electron.app.getVersion(), isPackaged: p.electron.app.isPackaged,
      collectorPid: p.collector.pid, menu: p.menu.items.map(i => ({label:i.label,type:i.type,enabled:i.enabled})),
      windowVisible: p.electron.BrowserWindow.getAllWindows()[0]?.isVisible() }; })()`), 45000, 'Actual Tray menu not ready');
  assert.equal(report.runtime.isPackaged, true);
  assert.equal(await listening(), true, 'Collector did not listen');
  report.processesBefore = descendants(await processes(), appProcess.pid);
  assert.ok(report.processesBefore.some(p => p.ProcessId === report.runtime.collectorPid));
  report.systemProtectedKey = fs.existsSync(path.join(fixture,'data','credential-key.dpapi')) && !fs.existsSync(path.join(fixture,'data','credential-key.local'));
  assert.equal(report.systemProtectedKey, true, 'Desktop did not initialize protected key');
  log('ready', { appPid: report.appPid, collectorPid: report.runtime.collectorPid, version: report.runtime.version });
  // Negative control: the product's ordinary close handler must only hide the window.
  await evaluate(`globalThis.__aiwmTrayExitTest.electron.BrowserWindow.getAllWindows()[0].close(); true`);
  await delay(300);
  report.closeOnly = { windowHidden: await evaluate(`!globalThis.__aiwmTrayExitTest.electron.BrowserWindow.getAllWindows()[0].isVisible()`), appStillRunning: !appExited, portStillListening: await listening() };
  assert.deepEqual(report.closeOnly, { windowHidden: true, appStillRunning: true, portStillListening: true });
  const scheduled = await evaluate(`(() => {
    const p = globalThis.__aiwmTrayExitTest, item = p.menu.items.find(i => i.label === ${JSON.stringify(exitLabel)});
    if (!item || !item.enabled || typeof item.click !== 'function') throw Error('Missing actual Tray exit callback');
    setTimeout(() => { p.mark('tray-exit-menu-callback', { label: item.label }); item.click(item, undefined, {}); }, 250);
    return item.label;
  })()`);
  assert.equal(scheduled, exitLabel);
  ws.close(); // Detach before the callback so the debugger cannot hold up shutdown.
  await until(() => appExited, 15000, 'Application did not exit through Tray callback');
  const ids = new Set(report.processesBefore.map(p => p.ProcessId));
  await until(async () => {
    report.processesRemaining = (await processes()).filter(p => ids.has(p.ProcessId));
    return report.processesRemaining.length === 0;
  }, 15000, 'A recorded application/collector descendant survived Tray exit');
  report.portClosed = !(await listening());
  assert.equal(report.portClosed, true);
  const rebound = net.createServer();
  await new Promise((resolve, reject) => { rebound.once('error', reject); rebound.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => rebound.close(resolve));
  report.portRebindSucceeded = true;
  report.events = fs.readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(report.events.filter(e => ['tray-exit-menu-callback','before-quit','will-quit','quit'].includes(e.event)).map(e=>e.event), ['tray-exit-menu-callback','before-quit','before-quit','will-quit','quit']);
  assert.ok(report.events.some(e=>e.event==='collector-graceful-shutdown'));
  assert.ok(report.events.some(e=>e.event==='collector-exit' && e.code===0));
  assert.equal(report.exitCode, 0);
  report.passed = true;
  log('passed', { processesRemaining: 0, portClosed: true, portRebindSucceeded: true, exitCode: report.exitCode });
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  log('failed', { error: error.message, appPid: appProcess?.pid });
  // Never terminate the app to make an exit assertion pass.
  if (paused && send) await send('Debugger.resume').catch(() => {});
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  for (const waiter of waiters.values()) clearTimeout(waiter.timer);
  appProcess?.stdout?.destroy(); appProcess?.stderr?.destroy(); appProcess?.unref();
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
}

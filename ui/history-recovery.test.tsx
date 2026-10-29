import React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { create, act, type ReactTestRenderer } from "react-test-renderer";
import { SettingsPage } from "./src/pages";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const text = (n: any): string =>
  typeof n === "string"
    ? n
    : Array.isArray(n)
      ? n.map(text).join("")
      : (n?.children ?? []).map(text).join("");
const button = (r: ReactTestRenderer, label: string) =>
  r.root.findAllByType("button").find((n) => text(n).trim() === label);
const select = (r: ReactTestRenderer) =>
  r.root.findByProps({ "aria-label": "选择用于补回历史的备份" });
const summary = (file: string) => ({
  file,
  token: "preview-" + file,
  counts: {
    sessionsRecovered: 32,
    eventsAdded: 39748,
    eventsArchived: 58044,
    metadataDuplicatesArchived: 351,
    quotasAdded: 5924,
    quotasArchived: 9047,
  },
  result: { sessions: 503, events: 109687, usagePoints: 6000, integrity: "ok" },
});

async function fixture(
  run: (
    r: ReactTestRenderer,
    calls: { url: string; body: any }[],
    notices: string[],
  ) => Promise<void>,
  handle: (
    url: string,
    body: any,
  ) => Promise<Response | undefined> = async () => undefined,
  backups = ["monitor-100.sqlite", "monitor-200.sqlite"],
) {
  const original = globalThis.fetch;
  const calls: { url: string; body: any }[] = [],
    notices: string[] = [];
  globalThis.fetch = async (input: any, init: any) => {
    const url = String(input),
      body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const custom = await handle(url, body);
    if (custom) return custom;
    if (url === "/api/settings")
      return Response.json({
        hooksEnabled: false,
        hooks: { status: "disabled", preview: {}, explanation: "" },
        notifications: { enabled: false },
        pollMs: 1500,
        staleMs: 15000,
        backups,
      });
    if (url === "/api/sources") return Response.json({ sources: [] });
    if (url === "/api/restore") return Response.json({ ok: true });
    if (url === "/api/history-recovery/preview")
      return Response.json(summary(body.file));
    if (url === "/api/history-recovery/apply")
      return Response.json({
        ...summary(body.file),
        counts: {
          ...summary(body.file).counts,
          sessionsRecovered: 33,
          eventsAdded: 39750,
        },
        backup: "monitor-300.sqlite",
      });
    throw Error("unexpected request " + url);
  };
  let r!: ReactTestRenderer;
  try {
    await act(async () => {
      r = create(
        <SettingsPage
          revision={0}
          notify={(s) => notices.push(s)}
          onChanged={() => {}}
        />,
      );
    });
    await run(r, calls, notices);
  } finally {
    if (r) await act(async () => r.unmount());
    globalThis.fetch = original;
  }
}

test("history preview is bound to the chosen backup and applying requires review confirmation", async () => {
  await fixture(async (r, calls) => {
    assert.equal(button(r, "预览可补回的历史")?.props.disabled, true);
    await act(async () =>
      select(r).props.onChange({ target: { value: "monitor-100.sqlite" } }),
    );
    await act(async () => {
      await button(r, "预览可补回的历史")!.props.onClick();
    });
    assert.match(text(r.toJSON()), /39,748/);
    assert.match(text(r.toJSON()), /5,924/);
    assert.doesNotMatch(text(r.toJSON()), /核对证据|隔离副本|另存为/);
    assert.equal(calls.filter((c) => c.url.endsWith("/apply")).length, 0);
    await act(async () =>
      select(r).props.onChange({ target: { value: "monitor-200.sqlite" } }),
    );
    assert.equal(
      button(r, "备份并补回历史"),
      undefined,
      "choosing another file must discard the previous preview token",
    );
    await act(async () => {
      await button(r, "预览可补回的历史")!.props.onClick();
    });
    await act(async () => {
      button(r, "备份并补回历史")!.props.onClick();
    });
    assert.equal(calls.filter((c) => c.url.endsWith("/apply")).length, 0);
    await act(async () => {
      button(r, "确认备份并补回")!.props.onClick();
    });
    const applies = calls.filter((c) => c.url.endsWith("/apply"));
    assert.deepEqual(
      applies.map((c) => c.body),
      [{ file: "monitor-200.sqlite", token: "preview-monitor-200.sqlite" }],
    );
    assert.match(text(r.toJSON()), /39,750/);
    assert.match(text(r.toJSON()), /monitor-300\.sqlite/);
    assert.equal(
      button(r, "备份并补回历史"),
      undefined,
      "an applied token must not be reusable",
    );
  });
});

test("pending preview disables changes and an expired apply token requires a fresh preview", async () => {
  let resolvePreview!: (r: Response) => void;
  await fixture(
    async (r, calls, notices) => {
      await act(async () =>
        select(r).props.onChange({ target: { value: "monitor-100.sqlite" } }),
      );
      let preview!: Promise<unknown>;
      await act(async () => {
        preview = button(r, "预览可补回的历史")!.props.onClick();
      });
      assert.equal(select(r).props.disabled, true);
      assert.equal(button(r, "预览可补回的历史")!.props.disabled, true);
      assert.equal(button(r, "备份并补回历史"), undefined);
      assert.match(text(r.toJSON()), /正在核对历史/);
      assert.doesNotMatch(text(r.toJSON()), /隔离副本/);
      await act(async () => {
        resolvePreview(Response.json(summary("monitor-100.sqlite")));
        await preview;
      });
      await act(async () => button(r, "备份并补回历史")!.props.onClick());
      await act(async () => button(r, "确认备份并补回")!.props.onClick());
      assert.match(text(r.toJSON()), /预览已过期/);
      assert.ok(notices.some((n) => n.includes("预览已过期")));
      assert.equal(button(r, "备份并补回历史"), undefined);
      assert.equal(select(r).props.disabled, false);
      assert.equal(calls.filter((c) => c.url.endsWith("/apply")).length, 1);
    },
    async (url) => {
      if (url.endsWith("/preview"))
        return new Promise<Response>((resolve) => {
          resolvePreview = resolve;
        });
      if (url.endsWith("/apply"))
        return Response.json(
          { error: "预览已过期，请重新预览" },
          { status: 400 },
        );
    },
  );
});

test("settings displays collection durations in seconds while saving the millisecond API values", async () => {
  await fixture(async (r, calls) => {
    const interval = () =>
      r.root.findByProps({ "aria-label": "刷新间隔（秒）" });
    const freshness = () =>
      r.root.findByProps({ "aria-label": "多久未更新后显示未知（秒）" });
    assert.equal(interval().props.value, 1.5);
    assert.equal(freshness().props.value, 15);
    await act(async () =>
      interval().props.onChange({ target: { value: "2.5" } }),
    );
    await act(async () =>
      freshness().props.onChange({ target: { value: "20" } }),
    );
    await act(async () => {
      await r.root
        .findByProps({ className: "settings-form" })
        .props.onSubmit({ preventDefault() {} });
    });
    const saved = calls.find((c) => c.url === "/api/settings" && c.body);
    assert.equal(saved?.body.pollMs, 2500);
    assert.equal(saved?.body.staleMs, 20000);
  });
});

test("backup options identify local time but retain filenames and restore warns about reconnecting", async () => {
  const timestamp = new Date(2026, 9, 29, 8, 5, 6).getTime();
  const file = `monitor-${timestamp}.sqlite`;
  const invalidTime = "monitor-9999999999999999999999999.sqlite";
  await fixture(
    async (r, calls) => {
      const options = select(r).findAllByType("option");
      const normal = options.find((n) => n.props.value === file)!;
      assert.match(text(normal), /2026\/10\/29.*08:05:06/);
      assert.match(text(normal), /监控备份/);
      assert.doesNotMatch(text(normal), /monitor-/);
      assert.match(
        text(options.find((n) => n.props.value === invalidTime)!),
        /时间未知/,
      );
      assert.doesNotMatch(text(r.toJSON()), /Invalid Date/);
      const restoreSelect = r.root.findByProps({
        "aria-label": "选择要恢复的备份",
      });
      assert.ok(
        restoreSelect
          .findAllByType("option")
          .some(
            (n) =>
              n.props.value === "legacy-backup.sqlite" &&
              text(n).includes("legacy-backup.sqlite"),
          ),
        "unrecognised names remain identifiable without inventing a date",
      );
      await act(async () =>
        restoreSelect.props.onChange({ target: { value: file } }),
      );
      await act(async () => button(r, "恢复备份")!.props.onClick());
      const dialog = text(r.root.findByType("dialog"));
      assert.match(dialog, /重新配对/);
      assert.match(dialog, /已删除/);
      assert.match(dialog, /已撤回/);
      assert.match(dialog, /Codex/);
      assert.equal(calls.filter((c) => c.url === "/api/restore").length, 0);
      await act(async () => button(r, "恢复此备份")!.props.onClick());
      assert.deepEqual(calls.find((c) => c.url === "/api/restore")?.body, {
        file,
      });
    },
    undefined,
    [file, invalidTime, "legacy-backup.sqlite"],
  );
});

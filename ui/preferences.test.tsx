import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { PreferenceControls } from "./src/preference-controls";
import {
  exportPreferences,
  parsePreferences,
  preferencePatch,
  preferencesOf,
  targetPreferences,
} from "./src/preferences";
import type { Settings } from "./src/api";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const saved: Settings = {
  pollMs: 1500,
  staleMs: 15000,
  retentionDays: 0,
  notifications: {
    enabled: false,
    quietStart: 23,
    quietEnd: 9,
    quotaThreshold: 20,
  },
  hooksEnabled: true,
  hooks: { enabled: true, explanation: "", preview: "local script path" },
  backups: ["private.sqlite"],
  hubUrl: "https://private.example",
  hubStatus: "paired",
};

test("portable preferences round trip only their six supported fields", () => {
  const file = exportPreferences(saved);
  const doc = JSON.parse(file);
  assert.deepEqual(Object.keys(doc).sort(), [
    "formatVersion",
    "preferences",
    "service",
  ]);
  assert.deepEqual(Object.keys(doc.preferences).sort(), [
    "enabled",
    "pollMs",
    "quietEnd",
    "quietStart",
    "quotaThreshold",
    "staleMs",
  ]);
  assert.doesNotMatch(file, /private|hooks|script path/);
  assert.deepEqual(parsePreferences(file), preferencesOf(saved));
  for (const wrong of [
    null,
    [],
    { ...doc, formatVersion: "1" },
    { ...doc, formatVersion: 2 },
    { ...doc, service: "different" },
    { ...doc, hooksEnabled: false },
    { ...doc, preferences: { ...doc.preferences, token: "secret" } },
    { ...doc, preferences: {} },
    { ...doc, preferences: null },
    ...[
      { enabled: 1 },
      { quietStart: -1 },
      { quietEnd: 24 },
      { quotaThreshold: 0 },
      { pollMs: "1500" },
      { staleMs: 300001 },
      { pollMs: 1000.5 },
    ].map((change) => ({
      ...doc,
      preferences: { ...doc.preferences, ...change },
    })),
  ])
    assert.throws(() => parsePreferences(JSON.stringify(wrong)));
  assert.throws(() => parsePreferences("{"));
});

test("changing a single setting preserves other values that changed after opening the form", () => {
  const before = preferencesOf(saved);
  const now = { ...before, quietEnd: 7, pollMs: 700 };
  assert.deepEqual(preferencePatch(before, { ...before, enabled: true }, now), {
    notifications: { ...saved.notifications, quietEnd: 7, enabled: true },
  });
  assert.deepEqual(preferencePatch(before, { ...before, pollMs: 1000 }, now), {
    pollMs: 1000,
  });
  assert.deepEqual(targetPreferences({ ...now, enabled: true }, "silent"), {
    ...now,
    enabled: false,
  });
});

test("presets write only after review and require a new confirmation if the preview changes", async () => {
  const original = globalThis.fetch;
  let latest = structuredClone(saved);
  let conflictOnNextWrite = false;
  const writes: unknown[] = [];
  const messages: string[] = [];
  globalThis.fetch = async (path, init) => {
    assert.equal(path, "/api/settings");
    if (init?.method === "POST") {
      const patch = JSON.parse(String(init.body));
      if (conflictOnNextWrite) {
        conflictOnNextWrite = false;
        latest.notifications = { ...latest.notifications, quietStart: 20 };
        return Response.json(
          { error: "设置已在其他窗口更改，请重新核对。" },
          { status: 409 },
        );
      }
      writes.push(patch);
      const { expected, ...settings } = patch;
      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(latest[key as keyof Settings], value);
      }
      latest = { ...latest, ...settings };
    }
    return Response.json(latest);
  };
  let tree!: ReactTestRenderer;
  try {
    await act(async () => {
      tree = create(
        <PreferenceControls
          busy={false}
          setBusy={() => {}}
          dirty={false}
          notify={(message) => messages.push(message)}
          onApplied={() => {}}
        />,
      );
    });
    const button = (label: string) =>
      tree.root
        .findAllByType("button")
        .find((node) => node.children.includes(label));
    await act(async () => {
      await button("日常提醒")!.props.onClick();
    });
    assert.equal(writes.length, 0);
    assert.equal(tree.root.findAllByType("td")[2].children[0], "23:00");
    latest = {
      ...latest,
      notifications: { ...latest.notifications, quietStart: 21 },
    };
    await act(async () => {
      await button("确认应用")!.props.onClick();
    });
    assert.equal(writes.length, 0);
    assert.match(messages.at(-1)!, /重新|核对/);
    assert.equal(tree.root.findAllByType("td")[2].children[0], "21:00");
    conflictOnNextWrite = true;
    await act(async () => {
      await button("确认应用")!.props.onClick();
    });
    assert.equal(writes.length, 0);
    assert.equal(tree.root.findAllByType("td")[2].children[0], "20:00");
    await act(async () => {
      await button("确认应用")!.props.onClick();
    });
    assert.deepEqual(writes, [
      {
        expected: { notifications: { ...saved.notifications, quietStart: 20 } },
        notifications: {
          enabled: true,
          quietStart: 22,
          quietEnd: 8,
          quotaThreshold: 15,
        },
      },
    ]);
    assert.equal(button("确认应用"), undefined);
    const chooseFile = (file: File) =>
      act(async () => {
        tree.root
          .findByProps({ type: "file" })
          .props.onChange({ target: { files: [file], value: file.name } });
      });
    await chooseFile(new File(["{}"], "other.json"));
    assert.equal(button("确认应用"), undefined);
    assert.equal(writes.length, 1);
    const imported = new File(
      [exportPreferences({ ...latest, staleMs: 5555 })],
      "preferences.json",
    );
    await chooseFile(imported);
    assert.equal(writes.length, 1);
    assert.equal(tree.root.findAllByType("td")[1].children[0], "5.555 秒");
    await act(async () => {
      button("取消")!.props.onClick();
    });
    assert.equal(button("确认应用"), undefined);
    await chooseFile(imported);
    await act(async () => {
      await button("确认应用")!.props.onClick();
    });
    assert.deepEqual(writes[1], {
      staleMs: 5555,
      expected: { staleMs: saved.staleMs },
    });
  } finally {
    if (tree) await act(async () => tree.unmount());
    globalThis.fetch = original;
  }
});

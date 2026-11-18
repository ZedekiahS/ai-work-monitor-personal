import type { Settings } from "./api";

export type Preferences = Pick<Settings, "pollMs" | "staleMs"> &
  Settings["notifications"];
const dailyNotifications = {
  enabled: true,
  quietStart: 22,
  quietEnd: 8,
  quotaThreshold: 15,
};
const labels = {
  enabled: "任务通知",
  quietStart: "免打扰开始",
  quietEnd: "免打扰结束",
  quotaThreshold: "低额度提醒阈值",
  pollMs: "刷新间隔",
  staleMs: "状态过期时间",
} satisfies Record<keyof Preferences, string>;
type Key = keyof Preferences;
const keys = Object.keys(labels) as Key[];

export function preferencesOf(settings: Settings): Preferences {
  const {
    enabled = false,
    quietStart = dailyNotifications.quietStart,
    quietEnd = dailyNotifications.quietEnd,
    quotaThreshold = dailyNotifications.quotaThreshold,
  } = settings.notifications;
  return {
    enabled,
    quietStart,
    quietEnd,
    quotaThreshold,
    pollMs: settings.pollMs,
    staleMs: settings.staleMs,
  };
}

export function exportPreferences(settings: Settings) {
  return JSON.stringify(
    {
      service: "ai-work-monitor",
      formatVersion: 1,
      preferences: validatePreferences(preferencesOf(settings)),
    },
    null,
    2,
  );
}

function hasFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

export function parsePreferences(content: string): Preferences {
  let file: unknown;
  try {
    file = JSON.parse(content);
  } catch {
    throw Error("请选择有效的 JSON 偏好文件。");
  }
  if (
    !hasFields(file, ["service", "formatVersion", "preferences"]) ||
    file.service !== "ai-work-monitor"
  )
    throw Error("请选择 Monitor 导出的偏好文件。");
  if (file.formatVersion !== 1) throw Error("此偏好文件的版本不受支持。");
  return validatePreferences(file.preferences);
}

function validatePreferences(p: unknown): Preferences {
  if (!hasFields(p, keys))
    throw Error("偏好文件的设置项不完整或包含不支持的设置。");
  if (typeof p.enabled !== "boolean")
    throw Error("任务通知需要设置为开启或关闭。");
  const integer = (key: Exclude<Key, "enabled">, min: number, max: number) => {
    const value = p[key];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < min ||
      value > max
    )
      throw Error(`偏好文件中的“${labels[key]}”超出范围或格式有误。`);
    return value;
  };
  return {
    enabled: p.enabled,
    quietStart: integer("quietStart", 0, 23),
    quietEnd: integer("quietEnd", 0, 23),
    quotaThreshold: integer("quotaThreshold", 1, 99),
    pollMs: integer("pollMs", 500, 60000),
    staleMs: integer("staleMs", 5000, 300000),
  };
}

export type PreferenceChoice = "daily" | "silent" | Preferences;
export function targetPreferences(
  current: Preferences,
  choice: PreferenceChoice,
): Preferences {
  if (choice === "daily") return { ...current, ...dailyNotifications };
  if (choice === "silent") return { ...current, enabled: false };
  return choice;
}

export function changedPreferences(before: Preferences, after: Preferences) {
  return keys.filter((key) => before[key] !== after[key]);
}

function format(key: Key, value: number | boolean): string {
  if (key === "enabled") return value ? "开启" : "关闭";
  if (key === "quietStart" || key === "quietEnd")
    return `${String(value).padStart(2, "0")}:00`;
  if (key === "quotaThreshold") return `${value}%`;
  return `${Number(value) / 1000} 秒`;
}

export function previewPreferences(current: Preferences, target: Preferences) {
  return changedPreferences(current, target).map((key) => ({
    label: labels[key],
    from: format(key, current[key]),
    to: format(key, target[key]),
  }));
}

// The settings API replaces notifications as a unit. Carry forward the latest
// values for any notification fields the user did not edit.
export function preferencePatch(
  base: Preferences,
  target: Preferences,
  current: Preferences,
) {
  const changed = changedPreferences(base, target);
  const patch: Partial<Pick<Settings, "pollMs" | "staleMs" | "notifications">> =
    {};
  const value = <K extends Key>(key: K) =>
    changed.includes(key) ? target[key] : current[key];
  if (changed.includes("pollMs")) patch.pollMs = target.pollMs;
  if (changed.includes("staleMs")) patch.staleMs = target.staleMs;
  if (changed.some((key) => key !== "pollMs" && key !== "staleMs"))
    patch.notifications = {
      enabled: value("enabled"),
      quietStart: value("quietStart"),
      quietEnd: value("quietEnd"),
      quotaThreshold: value("quotaThreshold"),
    };
  return patch;
}

export function guardPreferencePatch(
  current: Settings,
  patch: ReturnType<typeof preferencePatch>,
) {
  const expected: typeof patch = {};
  if (patch.pollMs !== undefined) expected.pollMs = current.pollMs;
  if (patch.staleMs !== undefined) expected.staleMs = current.staleMs;
  if (patch.notifications) expected.notifications = current.notifications;
  return { ...patch, expected };
}

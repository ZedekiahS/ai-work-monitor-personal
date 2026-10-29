import { useCallback, useEffect, useRef, useState } from "react";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  }).catch((error) => {
    if (error?.name === "AbortError") throw error;
    throw new ApiError(
      "无法连接本机采集服务，请确认 Monitor 正在运行后重试。",
      0,
    );
  });
  if (!response.ok) {
    let message = `请求失败 (${response.status})`;
    try {
      const body = await response.json();
      message = body.error?.message || body.error || body.message || message;
    } catch {}
    throw new ApiError(
      typeof message === "string" ? message : JSON.stringify(message),
      response.status,
    );
  }
  return response.status === 204 ? (null as T) : response.json();
}
export function mutate<T = any>(path: string, body?: unknown, method = "POST") {
  return api<T>(path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
export function useResource<T>(url: string | null, revision = 0) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [requested, setRequested] = useState(0);
  const request = useRef(0);
  const previousUrl = useRef<string | null>(null);
  const refresh = useCallback(() => setRequested((v) => v + 1), []);
  useEffect(() => {
    if (!url) {
      request.current++;
      previousUrl.current = null;
      setData(null);
      setError("");
      setLoading(false);
      return;
    }
    const id = ++request.current;
    if (previousUrl.current !== url) {
      setData(null);
      setError("");
      previousUrl.current = url;
    }
    setLoading(true);
    api<T>(url)
      .then((v) => {
        if (request.current === id) {
          setData(v);
          setError("");
        }
      })
      .catch((e) => {
        if (request.current === id) {
          setError(e.message);
          if (e instanceof ApiError && [401, 403, 409].includes(e.status))
            setData(null);
        }
      })
      .finally(() => {
        if (request.current === id) setLoading(false);
      });
    return () => {
      request.current++;
    };
  }, [url, revision, requested]);
  return { data, error, loading, refresh };
}
export type Usage = {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
};
export type Session = {
  id: string;
  title: string;
  project: string;
  model: string;
  sourceId: string;
  accountId: string | null;
  parentId: string | null;
  relation: "spawn" | "fork" | null;
  startedAt: string;
  updatedAt: string;
  turnId: string | null;
  state: string;
  lastState: string;
  evidence: string;
  freshness: string;
  totalTokens: number | null;
  metadataOnly?: boolean;
  usageAvailable?: boolean;
  usageUncertain?: boolean;
  pinned: boolean;
  notes: string;
  jumpUrl: string | null;
};
export type MonitorEvent = {
  id: string;
  sessionId: string;
  turnId: string | null;
  kind: string;
  occurredAt: string;
  observedAt: string;
  evidence: string;
  data: Record<string, unknown>;
};
export type Source = {
  id: string;
  label: string;
  kind: string;
  environmentId: string;
  pathLabel: string;
  health: string;
  lastScanAt: string | null;
  collectionEnabled?: boolean;
  errorCount: number;
  capabilities: Record<string, string>;
};
export type Scan = {
  phase: string;
  filesTotal: number;
  filesDone: number;
  eventsImported: number;
  errors: number;
  startedAt: string;
  finishedAt: string;
};
export type Quota = {
  id: string;
  accountId: string | null;
  pool: string;
  window: string;
  remainingPercent: number | null;
  resetsAt: string | null;
  observedAt: string;
  freshness: string;
  sourceId: string;
  displayGroup?: string;
  unbound?: boolean;
  historyCount?: number;
};
export type Account = { id: string; label: string; provider: string };
export type Binding = {
  id: string;
  accountId: string;
  sourceId: string;
  from: string;
  to: string | null;
  evidence: string;
  revoked: boolean;
};
export type Accounts = {
  accounts: Account[];
  bindings: Binding[];
  devices: { id: string; label: string }[];
  environments: { id: string; kind: string; label: string }[];
};
export type Overview = {
  sessions: number;
  events: number;
  usage: Usage;
  states: Record<string, number>;
  activity?: {
    items: Session[];
    mainCount: number;
    childCount: number;
    waitingCount: number;
    failedCount: number;
    unknownCount: number;
    total: number;
    truncated: boolean;
  };
  recentCompleted?: Session[];
  todayUsage?: Usage;
  usageUncertain?: boolean;
  activeEvidence?: { confirmed: number; inferred: number; unknown: number };
  scan: Scan;
  quotas: Quota[];
  sources: Source[];
  limitations: string[];
};
export type List = {
  items: Session[];
  total: number;
  page: number;
  pageSize: number;
};
export type Detail = {
  usageUncertain?: boolean;
  historyAvailable?: boolean;
  nextBefore?: string | null;
  session: Session;
  agents: Session[];
  events: MonitorEvent[];
  usage: Usage | null;
  notes: string;
  pinned: boolean;
};
export type Settings = {
  backups: string[];
  pollMs: number;
  staleMs: number;
  notifications: {
    enabled: boolean;
    quietStart: number;
    quietEnd: number;
    quotaThreshold: number;
  };
  retentionDays: number;
  hooksEnabled?: boolean;
  hubUrl: string;
  hubStatus: string;
  hooks: {
    enabled: boolean;
    preview: string;
    explanation: string;
    status?: string;
    updateAvailable?: boolean;
    missingEvents?: string[];
    lastEvent?: string | null;
  };
  hookCleanupError?: string | null;
};
export const number = (n: unknown) =>
  typeof n === "number" ? new Intl.NumberFormat("zh-CN").format(n) : "—";
export const compact = (n: unknown) =>
  typeof n === "number"
    ? new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(n)
    : "—";
export const date = (
  value: string | number | null | undefined,
  short = false,
) =>
  value && Number.isFinite(new Date(value).getTime())
    ? new Date(value).toLocaleString(
        "zh-CN",
        short
          ? {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            }
          : { hour12: false },
      )
    : "未知";
export const shortId = (id: string | null | undefined) =>
  id ? id.slice(0, 12) : "未确认";
export const stateNames: Record<string, string> = {
  running: "运行中",
  waiting_user: "等待输入",
  waiting_approval: "等待审批",
  idle: "空闲",
  completed: "已完成",
  failed: "任务失败",
  cancelled: "已中断",
  unknown: "待确认",
};
export const freshNames: Record<string, string> = {
  fresh: "已更新",
  stale: "已过期",
  unavailable: "不可用",
};
export function download(
  name: string,
  content: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function relativeTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "时间未知";
  const minutes = Math.round((Date.parse(value) - Date.now()) / 60000);
  if (Math.abs(minutes) < 1) return "刚刚";
  if (Math.abs(minutes) < 60)
    return new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" }).format(
      minutes,
      "minute",
    );
  if (Math.abs(minutes) < 1440)
    return new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" }).format(
      Math.round(minutes / 60),
      "hour",
    );
  return date(value, true).replace(/:\d{2}$/, "");
}

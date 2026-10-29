import type { Detail, Session, Quota } from "./api";

export function quotaRemaining(
  quota: Quota,
  unavailable = false,
  now = Date.now(),
) {
  return unavailable ||
    quota.freshness !== "fresh" ||
    (!!quota.resetsAt && Date.parse(quota.resetsAt) <= now)
    ? null
    : quota.remainingPercent;
}

export function accountName(id: string | null | undefined, label?: string) {
  return !id || id.startsWith("unknown:")
    ? "账号待确认"
    : label || "未命名账号";
}

export function sourceHealth(value: string) {
  return (
    (
      {
        ok: "正常",
        healthy: "正常",
        scanning: "读取中",
        degraded: "部分记录无法读取",
        unavailable: "无法访问",
        stale: "需要更新",
      } as Record<string, string>
    )[value] || "需要检查"
  );
}
export function sourceKind(value: string) {
  return (
    (
      {
        "windows-native": "Windows",
        "windows-cli": "Windows 命令行",
        "windows-desktop": "Windows 桌面端",
        "windows-desktop-or-cli": "本机 Codex",
        native: "本机环境",
        "wsl-cli": "WSL",
        manual: "自定义目录",
      } as Record<string, string>
    )[value] || value
  );
}

/** Choose display priority only; observations and account identities stay separate. */
export function quotasForOverview(quotas: Quota[], now = Date.now()) {
  const current: Quota[] = [],
    other: Quota[] = [];
  const seen = new Set<string>();
  for (const quota of [...quotas].sort((a, b) =>
    b.observedAt.localeCompare(a.observedAt),
  )) {
    const account =
      quota.unbound ||
      !quota.accountId ||
      quota.accountId.startsWith("unknown:")
        ? "unbound"
        : quota.accountId;
    const key = JSON.stringify([account, quota.pool, quota.window]);
    const valid =
      quota.freshness === "fresh" &&
      (!quota.resetsAt || Date.parse(quota.resetsAt) > now);
    if (valid && !seen.has(key)) {
      current.push(quota);
      seen.add(key);
    } else other.push(quota);
  }
  return { current, other };
}

const terminal = new Set(["completed", "failed", "cancelled"]);
/** A failed observer must never keep a cached nonterminal claim current. */
export function sessionForView(session: Session, unavailable = false): Session {
  if (!unavailable) return session;
  return {
    ...session,
    lastState: session.state === "unknown" ? session.lastState : session.state,
    state: terminal.has(session.state) ? session.state : "unknown",
    freshness: "unavailable",
    evidence: terminal.has(session.state) ? session.evidence : "unknown",
  };
}

/** Determine graph reachability before applying presentation collapse. */
export function forestFor(sessions: Session[]) {
  const unique = [...new Map(sessions.map((s) => [s.id, s])).values()];
  const ids = new Set(unique.map((s) => s.id));
  const children = new Map<string, Session[]>();
  unique.forEach((s) => {
    if (
      s.parentId &&
      s.parentId !== s.id &&
      ids.has(s.parentId) &&
      s.relation !== "fork"
    ) {
      children.set(s.parentId, [...(children.get(s.parentId) || []), s]);
    }
  });
  const roots = unique.filter(
    (s) =>
      !s.parentId ||
      !ids.has(s.parentId) ||
      s.relation === "fork" ||
      s.parentId === s.id,
  );
  const reached = new Set<string>();
  const visit = (s: Session) => {
    if (reached.has(s.id)) return;
    reached.add(s.id);
    (children.get(s.id) || []).forEach(visit);
  };
  roots.forEach(visit);
  // A malformed cycle remains inspectable; do not invent a parent to break it.
  unique.forEach((s) => {
    if (!reached.has(s.id)) {
      roots.push(s);
      visit(s);
    }
  });
  return { roots, children };
}

export function quotaWindow(value: string | number) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0)
    return !value || String(value).startsWith("unknown:")
      ? "周期未知"
      : String(value);
  if (minutes % 1440 === 0) return `${minutes / 1440} 天窗口`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时窗口`;
  return `${minutes} 分钟窗口`;
}

/** Explicit database cursors are authoritative, including null at the end. */
export function historyForDetail(detail: Detail | null) {
  if (!detail) return { available: false, nextBefore: null };
  const available = detail.historyAvailable ?? !detail.session.metadataOnly;
  if (!available) return { available, nextBefore: null };
  if (detail.nextBefore !== undefined)
    return { available, nextBefore: detail.nextBefore };
  const events = [...detail.events].sort((a, b) =>
    a.occurredAt.localeCompare(b.occurredAt),
  );
  const oldest = events[0];
  const cursor = oldest?.data.historyCursor;
  return {
    available,
    nextBefore:
      events.length >= 200
        ? typeof cursor === "string"
          ? cursor
          : (oldest?.occurredAt ?? null)
        : null,
  };
}

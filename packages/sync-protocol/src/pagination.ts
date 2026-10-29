import { randomUUID } from "node:crypto";
export function encodeCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function decodeCursor<T>(value: string): T {
  if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw Error("无效分页游标");
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw Error("无效分页游标");
  }
}
/** Frozen membership, not frozen authorization. Callers re-check access/deletion for every page. */
export class ExportSnapshots<T> {
  private snapshots = new Map<
    string,
    { scope: string; at: string; expires: number; items: T[] }
  >();
  page(scope: string, cursor: string | null, load: () => T[], limit = 200) {
    const now = Date.now();
    for (const [id, s] of this.snapshots)
      if (s.expires < now) this.snapshots.delete(id);
    let id: string, offset: number;
    if (cursor) {
      const c = decodeCursor<any>(cursor);
      id = c.id;
      offset = c.offset;
      if (typeof id !== "string" || !Number.isSafeInteger(offset) || offset < 0)
        throw Error("无效导出游标");
    } else {
      id = randomUUID();
      offset = 0;
      this.snapshots.set(id, {
        scope,
        at: new Date(now).toISOString(),
        expires: now + 15 * 60_000,
        items: load(),
      });
    }
    const snapshot = this.snapshots.get(id);
    if (!snapshot || snapshot.scope !== scope)
      throw Error("导出范围变化或快照已过期，请重新导出");
    const items = snapshot.items.slice(offset, offset + limit),
      next = offset + items.length;
    return {
      items,
      nextCursor:
        next < snapshot.items.length
          ? encodeCursor({ id, offset: next })
          : null,
      snapshotAt: snapshot.at,
      snapshotCount: snapshot.items.length,
    };
  }
}

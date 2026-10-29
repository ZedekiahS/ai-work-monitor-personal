/** Complete a fixed export snapshot; empty pages may result from revoked rows. */
export type ExportPage<T> = {
  items: T[];
  nextCursor: string | null;
  snapshotAt: string;
  snapshotCount?: number;
  count?: number;
};
export async function collectExport<T>(
  read: (cursor: string | null) => Promise<ExportPage<T>>,
  valid = () => true,
) {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let snapshotAt = "";
  let snapshotCount = 0;
  do {
    if (!valid()) throw new Error("导出范围已切换，请重新导出");
    const page = await read(cursor);
    if (!valid()) throw new Error("导出范围已切换，请重新导出");
    if (
      !Array.isArray(page.items) ||
      typeof page.snapshotAt !== "string" ||
      !(page.nextCursor === null || typeof page.nextCursor === "string")
    )
      throw new Error("服务端未提供完整导出游标，请升级后重试");
    if (snapshotAt && page.snapshotAt !== snapshotAt)
      throw new Error("导出快照发生变化，请重新导出");
    snapshotAt = page.snapshotAt;
    snapshotCount = page.snapshotCount ?? snapshotCount;
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor) {
      if (seen.has(cursor))
        throw new Error("导出游标重复，已停止以防遗漏或重复");
      seen.add(cursor);
    }
  } while (cursor !== null);
  return {
    items,
    count: items.length,
    snapshotAt,
    snapshotCount,
    range: "开始时的记录范围；期间新增不纳入，已撤回或无权访问的记录排除",
  };
}
export function exportCsv(items: Record<string, unknown>[]) {
  const columns = [...new Set(items.flatMap(Object.keys))];
  const cell = (value: unknown) => {
    let raw =
      typeof value === "object" && value !== null
        ? JSON.stringify(value)
        : String(value ?? "");
    if (/^[=+@-]/.test(raw)) raw = "'" + raw;
    return '"' + raw.replaceAll('"', '""') + '"';
  };
  return (
    "\ufeff" +
    [
      columns.map(cell).join(","),
      ...items.map((item) => columns.map((key) => cell(item[key])).join(",")),
    ].join("\r\n")
  );
}

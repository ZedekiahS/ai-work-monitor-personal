import { hash, usageOf, zeroUsage } from "./model.js";
import type { Event, Usage } from "./model.js";

export interface UsagePoint {
  event: Event;
  usage: Usage;
  id: string;
}
export interface UsageProjection {
  usage: Usage;
  points: UsagePoint[];
  uncertain: boolean;
  corrections: number;
}
const keys = ["input", "cached", "output", "reasoning"] as const;
const order = (a: Event, b: Event) =>
  a.occurredAt.localeCompare(b.occurredAt) ||
  a.sequence - b.sequence ||
  a.id.localeCompare(b.id);
function add(a: Usage, b: Usage) {
  for (const k of keys) a[k] += b[k];
  a.total = a.input + a.output;
}
function difference(a: Usage, b: Usage): Usage {
  return usageOf(
    Object.fromEntries(keys.map((k) => [k, Math.max(0, a[k] - b[k])])),
  );
}
type Node = { event: Event; usage: Usage; snapshot: boolean; id: string };

/**
 * A cumulative checkpoint covers the interval since its prior checkpoint, not
 * merely the last response. Response rows in that interval are candidates for
 * the same usage. A response emitted after a same-turn checkpoint can also be
 * a delayed representation of it. Those candidates form coverage components.
 *
 * Without upstream response-to-checkpoint IDs, overlap inside a mixed component
 * cannot be exactly assigned. Preserve the greater observable input/output
 * lower bound (direct rows plus unrepresented checkpoint residual), flag it,
 * and never pretend the checkpoint residual is an exact response/day allocation.
 * Same values alone never form an overlap edge. Distinct turns beyond the final
 * checkpoint remain additive; checkpoint-only history is retained.
 */
export function reconcileUsage(events: Event[]): UsageProjection {
  let uncertain = events.some((e) => e.data.usageUncertain === true),
    corrections = 0;
  const points: UsagePoint[] = [];
  const raw = [...events].sort(order);
  const seen = new Set<string>();
  const sessions = new Map<string, Event[]>();
  const forked = new Set<string>();
  const inheritedCheckpoints = new Map<string, Event[]>();
  for (const e of raw) {
    const key = JSON.stringify([e.provider, e.sessionId]);
    if (
      e.kind === "session_meta" &&
      (e.data.forked === true ||
        e.data.relation === "fork" ||
        Number.isSafeInteger(e.data.cutoff))
    )
      forked.add(key);
    if (
      e.kind === "usage_snapshot" &&
      e.data.inherited &&
      e.data.usageUncertain !== true
    ) {
      const checkpoints = inheritedCheckpoints.get(key) || [];
      checkpoints.push(e);
      inheritedCheckpoints.set(key, checkpoints);
    }
    if (
      e.data.inherited ||
      !["usage_response", "usage_snapshot"].includes(e.kind)
    )
      continue;
    const business =
      e.kind === "usage_response" && e.upstreamId
        ? JSON.stringify([e.provider, e.sessionId, "response", e.upstreamId])
        : `event:${e.id}`;
    if (seen.has(business)) continue;
    seen.add(business);
    const group = sessions.get(key) || [];
    group.push(e);
    sessions.set(key, group);
  }
  for (const [sessionKey, rows] of sessions) {
    const segments: Node[][] = [[]];
    const firstCheckpoint = rows.find((e) => e.kind === "usage_snapshot");
    const inheritedBaseline = firstCheckpoint
      ? inheritedCheckpoints
          .get(sessionKey)
          ?.filter((e) => order(e, firstCheckpoint) < 0)
          .at(-1)
      : undefined;
    let previous = inheritedBaseline
        ? usageOf(inheritedBaseline.data.usage)
        : zeroUsage(),
      unknownForkBaseline = forked.has(sessionKey) && !inheritedBaseline,
      epoch: string | null = null;
    for (const e of rows) {
      const u = usageOf(e.data.usage);
      const explicitEpoch =
        typeof e.data.usageEpoch === "string" ? e.data.usageEpoch : null;
      const explicitReset =
        e.data.counterReset === true ||
        (explicitEpoch !== null && epoch !== null && epoch !== explicitEpoch);
      if (explicitEpoch !== null) epoch = explicitEpoch;
      if (explicitReset) {
        previous = zeroUsage();
        unknownForkBaseline = false;
        segments.push([]);
      }
      let d = u;
      if (e.kind === "usage_snapshot") {
        if (unknownForkBaseline) {
          // A fork's first owned cumulative counter may include its parent's
          // history. Without a retained inherited checkpoint, only subsequent
          // increments (and direct child response records) are attributable.
          uncertain = true;
          unknownForkBaseline = false;
          d = zeroUsage();
        } else if (u.input < previous.input || u.output < previous.output) {
          // A lower cumulative counter can be a reset or a correction. Its new
          // baseline is unknown, so do not invent the missing reset-period sum.
          corrections++;
          uncertain = true;
          segments.push([]);
          d = zeroUsage();
        } else d = difference(u, previous);
        previous = u;
      }
      segments.at(-1)!.push({
        event: e,
        usage: d,
        snapshot: e.kind === "usage_snapshot",
        id:
          e.kind === "usage_response"
            ? "usage:v3:response:" +
              hash(
                JSON.stringify([e.provider, e.sessionId, e.upstreamId ?? e.id]),
              )
            : e.id + ":delta",
      });
    }
    for (const nodes of segments) {
      if (!nodes.length) continue;
      const parent = nodes.map((_, i) => i);
      const find = (n: number): number => {
        while (parent[n] !== n) {
          parent[n] = parent[parent[n]];
          n = parent[n];
        }
        return n;
      };
      const union = (a: number, b: number) => {
        parent[find(a)] = find(b);
      };
      const turnSnapshot = new Map<string, number>();
      const snapshots: number[] = [];
      for (let i = 0; i < nodes.length; i++) {
        if (!nodes[i].snapshot) continue;
        snapshots.push(i);
        const turn = nodes[i].event.turnId;
        if (turn) {
          if (turnSnapshot.has(turn)) union(i, turnSnapshot.get(turn)!);
          else turnSnapshot.set(turn, i);
        }
      }
      let next = 0;
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].snapshot) continue;
        while (next < snapshots.length && snapshots[next] < i) next++;
        // The first subsequent cumulative checkpoint covers this logical interval.
        if (next < snapshots.length) union(i, snapshots[next]);
        const turn = nodes[i].event.turnId;
        if (turn && turnSnapshot.has(turn)) union(i, turnSnapshot.get(turn)!);
        else if (!turn && snapshots.length) {
          // No turn evidence means a late response might describe the last
          // checkpoint. Keep the conservative lower bound and expose uncertainty.
          union(i, snapshots[Math.min(next, snapshots.length - 1)]);
        }
      }
      const components = new Map<number, Node[]>();
      for (let i = 0; i < nodes.length; i++) {
        const key = find(i),
          group = components.get(key) || [];
        group.push(nodes[i]);
        components.set(key, group);
      }
      for (const component of components.values()) {
        const direct = component.filter((n) => !n.snapshot),
          cumulative = component.filter((n) => n.snapshot);
        const mixed = direct.length > 0 && cumulative.length > 0;
        if (mixed) uncertain = true;
        const responseTotal = zeroUsage(),
          snapshotTotal = zeroUsage();
        for (const n of direct) add(responseTotal, n.usage);
        for (const n of cumulative) add(snapshotTotal, n.usage);
        const append = (n: Node, u: Usage) => {
          if (!u.total) return;
          points.push({
            id: n.id,
            usage: u,
            event: {
              ...n.event,
              data: {
                ...n.event.data,
                usageAllocationUncertain: mixed,
                usageBasis: mixed
                  ? "mixed_coverage_lower_bound"
                  : n.snapshot
                    ? "cumulative_checkpoint_delta"
                    : "response_record",
              },
            },
          });
        };
        for (const n of direct) append(n, n.usage);
        const remaining = mixed
          ? difference(snapshotTotal, responseTotal)
          : snapshotTotal;
        for (const n of cumulative) {
          const allocated = usageOf(
            Object.fromEntries(
              keys.map((k) => [k, Math.min(n.usage[k], remaining[k])]),
            ),
          );
          append(n, allocated);
          for (const k of keys) remaining[k] -= allocated[k];
        }
      }
    }
  }
  points.sort((a, b) => order(a.event, b.event) || a.id.localeCompare(b.id));
  const usage = zeroUsage();
  for (const point of points) add(usage, point.usage);
  return { usage, points, uncertain, corrections };
}

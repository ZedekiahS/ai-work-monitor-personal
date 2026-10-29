import { Store } from "../core/store.js";
import { refreshQuota } from "./quota.js";
export class QuotaScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  constructor(
    private store: Store,
    private changed: () => void = () => {},
    private refresh = refreshQuota,
  ) {}
  start() {
    this.stopped = false;
    this.schedule(5000);
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
  private schedule(ms: number) {
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), ms);
  }
  async tick() {
    if (this.stopped) return;
    const state = this.store.getSetting<any>("quotaRefresh", {});
    if (Number(state.nextAllowedAt) > Date.now()) {
      this.schedule(Number(state.nextAllowedAt) - Date.now() + 1000);
      return;
    }
    try {
      await this.refresh(this.store);
      this.changed();
    } finally {
      const next =
        this.store.getSetting<any>("quotaRefresh", {}).nextAllowedAt ??
        Date.now() + 60000;
      this.schedule(
        Math.max(60000, Number(next) - Date.now()) +
          Math.floor(Math.random() * 5000),
      );
    }
  }
}

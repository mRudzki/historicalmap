import type { HistoryFeature } from './api';

export interface RewindPage {
  features: HistoryFeature[];
  total: number;
  offset: number;
  nextOffset: number | null;
}

export interface RewindOptions {
  fetchPage: (offset: number, limit: number) => Promise<RewindPage>;
  onChange: () => void;
  firstPage?: number; // small, so the first period shows up quickly
  pageSize?: number;
  prefetchAhead?: number; // fetch the next page when at most this many periods are left ahead of the user
}

// Steps back through the periods a place belonged to (newest first), loading them page by page: a small first
// page, then the next ones in the background ahead of the user, so stepping stays instant.
export class Rewind {
  items: HistoryFeature[] = [];
  total = 0;
  index = 0;
  loading = false;
  error = false;

  private nextOffset: number | null = 0;
  private generation = 0; // bumped by start(): answers of a superseded start are ignored
  private inflight: Promise<void> | null = null;

  constructor(private opts: RewindOptions) {}

  private get firstPage() { return this.opts.firstPage ?? 3; }
  private get pageSize() { return this.opts.pageSize ?? 6; }
  private get ahead() { return this.opts.prefetchAhead ?? 2; }

  get current(): HistoryFeature | undefined { return this.items[this.index]; }
  get canNewer(): boolean { return this.index > 0; }
  get canOlder(): boolean { return this.index + 1 < this.items.length || this.nextOffset !== null; }

  async start(): Promise<void> {
    this.generation++;
    this.items = [];
    this.total = 0;
    this.index = 0;
    this.error = false;
    this.nextOffset = 0;
    this.inflight = null;
    await this.load(this.firstPage);
    this.prefetch();
  }

  async older(): Promise<void> {
    if (this.index + 1 >= this.items.length) {
      if (this.nextOffset === null) return;
      await this.load(this.pageSize); // the user outran the prefetch: wait for the page
    }
    if (this.index + 1 < this.items.length) {
      this.index++;
      this.changed();
      this.prefetch();
    }
  }

  newer(): void {
    if (this.index === 0) return;
    this.index--;
    this.changed();
  }

  goTo(i: number): void {
    this.index = Math.max(0, Math.min(i, this.items.length - 1));
    this.changed();
    this.prefetch();
  }

  async retry(): Promise<void> {
    this.error = false;
    await this.load(this.pageSize);
  }

  async whenIdle(): Promise<void> {
    while (this.inflight) await this.inflight;
  }

  private changed(): void {
    this.opts.onChange();
  }

  private prefetch(): void {
    if (this.nextOffset === null || this.error || this.inflight) return;
    if (this.items.length - 1 - this.index <= this.ahead) void this.load(this.pageSize);
  }

  private load(limit: number): Promise<void> {
    if (this.inflight) return this.inflight;
    const offset = this.nextOffset;
    if (offset === null) return Promise.resolve();
    const generation = this.generation;
    this.loading = true;
    this.changed();
    const request = (async () => {
      try {
        const page = await this.opts.fetchPage(offset, limit);
        if (generation !== this.generation) return;
        this.items.push(...page.features);
        this.total = page.total;
        this.nextOffset = page.nextOffset;
        this.error = false;
      } catch {
        if (generation === this.generation) this.error = true;
      } finally {
        if (generation === this.generation) {
          this.loading = false;
          this.inflight = null;
          this.changed();
          this.prefetch();
        }
      }
    })();
    this.inflight = request;
    return request;
  }
}

import { formatBytes } from "../core/utils.js";

const RENDER_INTERVAL = 250;

/**
 * 多文件下载的进度行（写 stderr，原地刷新）。
 * enabled=false 时 render 为空操作，log 仍照常输出（--json 时由调用方关掉 log）。
 */
export class TransferProgress {
  private readonly bytesById = new Map<string, number>();
  private baseline = 0;
  private finished = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly startedAt = Date.now();
  private drawn = false;

  constructor(
    private readonly totalBytes: number,
    private readonly totalCount: number,
    private readonly enabled: boolean,
    private readonly quiet = false,
  ) {}

  start(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => this.render(), RENDER_INTERVAL);
    this.timer.unref?.();
  }

  /** 某个文件当前已就绪的字节数；首次上报的值（续传已有部分）不计入速度 */
  update(id: string, bytes: number): void {
    if (!this.bytesById.has(id)) this.baseline += bytes;
    this.bytesById.set(id, bytes);
  }

  /** 一个文件结束（成功或失败），打印一行结果 */
  complete(message: string): void {
    this.finished++;
    this.log(message);
  }

  log(message: string): void {
    if (this.quiet) return;
    this.clear();
    process.stderr.write(message + "\n");
    if (this.enabled) this.render();
  }

  stop(): void {
    clearInterval(this.timer);
    this.clear();
  }

  private get doneBytes(): number {
    let sum = 0;
    for (const v of this.bytesById.values()) sum += v;
    return sum;
  }

  private render(): void {
    if (!this.enabled) return;
    const done = this.doneBytes;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const speed = elapsed > 0 ? Math.max(0, done - this.baseline) / elapsed : 0;
    const pct = this.totalBytes > 0 ? ((done / this.totalBytes) * 100).toFixed(1) : "0.0";
    const line =
      `⬇️  ${this.finished}/${this.totalCount}  ${formatBytes(done)} / ${formatBytes(this.totalBytes)}` +
      `  (${pct}%)  ${formatBytes(speed)}/s`;
    process.stderr.write(`\r\x1b[2K${line}`);
    this.drawn = true;
  }

  private clear(): void {
    if (this.drawn) {
      process.stderr.write("\r\x1b[2K");
      this.drawn = false;
    }
  }
}

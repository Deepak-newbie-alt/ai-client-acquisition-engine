import type { Db } from "../../lib/db.js";
import type { Logger } from "../../lib/logger.js";

export interface ResearchQueueLike {
  enqueue(runId: string): void;
}

/**
 * In-process FIFO queue that runs one research job at a time. Runs are
 * persisted as QUEUED first, so nothing is lost if the process restarts:
 * see recoverResearchRuns.
 */
export class ResearchQueue implements ResearchQueueLike {
  private readonly pending: string[] = [];
  private active: Promise<void> | null = null;
  private current: string | null = null;

  constructor(
    private readonly process: (runId: string) => Promise<void>,
    private readonly logger: Logger,
  ) {}

  enqueue(runId: string): void {
    if (runId !== this.current && !this.pending.includes(runId)) this.pending.push(runId);
    this.start();
  }

  /** Resolves once every queued job has finished. */
  async onIdle(): Promise<void> {
    while (this.active) await this.active;
  }

  private start(): void {
    if (this.active) return;
    this.active = this.drain().finally(() => {
      this.active = null;
      if (this.pending.length > 0) this.start();
    });
  }

  private async drain(): Promise<void> {
    for (let runId = this.pending.shift(); runId !== undefined; runId = this.pending.shift()) {
      this.current = runId;
      try {
        await this.process(runId);
      } catch (err) {
        this.logger.error({ err, runId }, "research job crashed");
      } finally {
        this.current = null;
      }
    }
  }
}

/** On startup: runs left RUNNING by a crash are failed; QUEUED runs are resumed. */
export async function recoverResearchRuns(db: Db, queue: ResearchQueueLike): Promise<void> {
  await db.researchRun.updateMany({
    where: { status: "RUNNING" },
    data: {
      status: "FAILED",
      errorCode: "INTERRUPTED",
      errorMessage: "The server stopped while this run was in progress",
      completedAt: new Date(),
    },
  });
  const queued = await db.researchRun.findMany({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  queued.forEach((r) => queue.enqueue(r.id));
}

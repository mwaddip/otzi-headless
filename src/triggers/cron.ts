// CronTrigger — wall-clock scheduler that fires a named job against a
// caller-supplied handler. Built on `croner` (zero-dep, standard 5- or 6-field
// cron expressions, e.g. "0 0 * * *" for daily midnight).
//
// The trigger itself does NOT know about ceremonies; the handler (owned by the
// daemon entrypoint) decides what the tick means. Errors thrown by the handler
// are caught and logged — they never crash the scheduler.

import { Cron } from 'croner';
import { NOOP_LOGGER, type Logger } from '../orchestrator/types';
import type { CronHandler, CronTriggerConfig, TriggerSource } from './types';

export class CronTrigger implements TriggerSource {
  private readonly jobName: string;
  private readonly schedule: string;
  private readonly handler: CronHandler;
  private readonly log: Logger;
  private readonly timezone: string | undefined;
  private job: Cron | null = null;

  constructor(config: CronTriggerConfig) {
    this.jobName = config.jobName;
    this.schedule = config.schedule;
    this.handler = config.handler;
    this.timezone = config.timezone;
    this.log = config.logger ?? NOOP_LOGGER;
    // Validate the schedule eagerly so bad expressions fail at construction,
    // not at first tick. croner throws on invalid expressions.
    new Cron(this.schedule, { paused: true }).stop();
  }

  start(): void {
    if (this.job) return;
    this.job = new Cron(
      this.schedule,
      { name: this.jobName, ...(this.timezone ? { timezone: this.timezone } : {}) },
      () => {
        void this.fire();
      },
    );
    this.log.info('CronTrigger: started', {
      jobName: this.jobName,
      schedule: this.schedule,
      timezone: this.timezone,
      next: this.job.nextRun()?.toISOString(),
    });
  }

  stop(): void {
    if (!this.job) return;
    this.job.stop();
    this.job = null;
    this.log.info('CronTrigger: stopped', { jobName: this.jobName });
  }

  /** Next scheduled fire time, or null if stopped / no more runs. */
  nextRun(): Date | null {
    return this.job?.nextRun() ?? null;
  }

  private async fire(): Promise<void> {
    const tick = { jobName: this.jobName, firedAt: new Date() };
    try {
      await this.handler(tick);
    } catch (err) {
      this.log.error('CronTrigger: handler threw', {
        jobName: this.jobName,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

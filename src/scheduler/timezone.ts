import { CronExpressionParser } from 'cron-parser';

export const POKE_TIMEZONE = 'Asia/Karachi';

export function parseDurationMs(durationStr: string): number {
  const trimmed = durationStr.trim().toLowerCase();

  // If pure number
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  const match = trimmed.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hrs?|hours?|d|days?)$/);
  if (!match) {
    throw new Error(`Invalid interval format: "${durationStr}". Examples: "30s", "15m", "2h", "1d".`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  if (unit.startsWith('s')) return value * 1000;
  if (unit.startsWith('m')) return value * 60 * 1000;
  if (unit.startsWith('h')) return value * 60 * 60 * 1000;
  if (unit.startsWith('d')) return value * 24 * 60 * 60 * 1000;

  throw new Error(`Unknown duration unit: ${unit}`);
}

export function computeNextRun(
  scheduleType: 'once' | 'cron' | 'interval',
  scheduleValue: string,
  fromTimeMs = Date.now()
): number | null {
  if (scheduleType === 'once') {
    let toParse = scheduleValue.trim();
    if (/^\d+$/.test(toParse)) {
      const parsedNum = parseInt(toParse, 10);
      if (parsedNum <= fromTimeMs) {
        throw new Error(`One-off schedule must be set in the future (${POKE_TIMEZONE}).`);
      }
      return parsedNum;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(toParse)) {
      toParse = `${toParse}T00:00:00+05:00`;
    } else {
      const hasTzOffset = /([zZ]|[+-]\d{2}(:?\d{2})?)$/.test(toParse);
      if (!hasTzOffset) {
        toParse = toParse.replace(' ', 'T');
        toParse = `${toParse}+05:00`;
      }
    }

    const parsed = Date.parse(toParse);
    if (isNaN(parsed)) {
      throw new Error(`Invalid date/time for "once" schedule: "${scheduleValue}"`);
    }
    if (parsed <= fromTimeMs) {
      throw new Error(`One-off schedule must be set in the future (${POKE_TIMEZONE}).`);
    }
    return parsed;
  }

  if (scheduleType === 'interval') {
    const intervalMs = parseDurationMs(scheduleValue);
    if (intervalMs <= 0) {
      throw new Error(`Interval duration must be positive: "${scheduleValue}"`);
    }
    return fromTimeMs + intervalMs;
  }

  if (scheduleType === 'cron') {
    try {
      const interval = CronExpressionParser.parse(scheduleValue, {
        currentDate: new Date(fromTimeMs),
        tz: POKE_TIMEZONE,
      });
      const nextDate = interval.next().toDate();
      return nextDate.getTime();
    } catch (err: any) {
      throw new Error(`Invalid cron expression "${scheduleValue}": ${err.message}`);
    }
  }

  throw new Error(`Unsupported schedule type: ${scheduleType}`);
}

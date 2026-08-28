/** Minimal levelled logger. Capture runs are long, so output stays readable. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: Level): void {
  threshold = LEVELS[level];
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

/** Receives every emitted line, so a running job can stream its own log. */
export type LogSink = (level: Level, message: string) => void;

const sinks = new Set<LogSink>();

export function addLogSink(sink: LogSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

function emit(level: Level, icon: string, msg: string, ...rest: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const line = `${ts()} ${icon} ${msg}`;
  if (level === 'error') console.error(line, ...rest);
  else if (level === 'warn') console.warn(line, ...rest);
  else console.log(line, ...rest);

  for (const sink of sinks) {
    try {
      sink(level, msg);
    } catch {
      /* a failing sink must never break the run */
    }
  }
}

export const log = {
  debug: (m: string, ...r: unknown[]) => emit('debug', '  ', m, ...r),
  info: (m: string, ...r: unknown[]) => emit('info', '›', m, ...r),
  step: (m: string, ...r: unknown[]) => emit('info', '→', m, ...r),
  ok: (m: string, ...r: unknown[]) => emit('info', '✓', m, ...r),
  warn: (m: string, ...r: unknown[]) => emit('warn', '!', m, ...r),
  error: (m: string, ...r: unknown[]) => emit('error', '✗', m, ...r),
};

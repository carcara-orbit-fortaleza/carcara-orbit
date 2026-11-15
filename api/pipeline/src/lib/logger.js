const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = process.env.LOG_LEVEL ?? 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(name, args) {
    if ((LEVELS[name] ?? 0) < threshold) return;
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] ${name.toUpperCase()}`;
    if (name === 'error') console.error(prefix, ...args);
    else if (name === 'warn') console.warn(prefix, ...args);
    else console.log(prefix, ...args);
  }

  return {
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  };
}

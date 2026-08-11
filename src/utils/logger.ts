function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  info(msg: string, meta?: Record<string, unknown>): void {
    console.log(`[${timestamp()}] [INFO] ${msg}`, meta ?? '');
  },
  warn(msg: string, meta?: Record<string, unknown>): void {
    console.warn(`[${timestamp()}] [WARN] ${msg}`, meta ?? '');
  },
  error(msg: string, meta?: Record<string, unknown>): void {
    console.error(`[${timestamp()}] [ERROR] ${msg}`, meta ?? '');
  },
};

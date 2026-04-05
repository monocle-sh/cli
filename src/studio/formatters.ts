import pc from "picocolors";

interface FlatLog {
  timestampUnix: bigint | string;
  traceId: string | null;
  spanId: string | null;
  severityText: string | null;
  severityNumber: number | null;
  serviceName: string | null;
  body: string | null;
  logAttributes: Record<string, unknown> | null;
}

type Format = "pretty" | "json" | "short";

/**
 * Format a unix nanosecond timestamp to a HH:mm:ss.SSS string.
 */
function formatTimestamp(unixNano: bigint | string): string {
  return new Date(Number(BigInt(unixNano)) / 1_000_000).toISOString().slice(11, 23);
}

/**
 * Return a colorizer based on log severity level.
 */
function severityColor(severity: string | null): (s: string) => string {
  const s = (severity ?? "").toUpperCase();
  if (s === "ERROR" || s === "FATAL") return pc.red;
  if (s === "WARN" || s === "WARNING") return pc.yellow;
  if (s === "INFO") return pc.cyan;
  if (s === "DEBUG" || s === "TRACE") return pc.dim;
  return pc.white;
}

/**
 * Format a log entry for terminal output.
 * Supports pretty, short, and json formats.
 */
export function formatLog(log: FlatLog, format: Format): string {
  if (format === "json") return JSON.stringify(log);

  const time = formatTimestamp(log.timestampUnix);
  const severity = (log.severityText ?? "INFO").toUpperCase().padEnd(5);
  const color = severityColor(log.severityText);
  const service = log.serviceName ?? "unknown";
  const body = log.body ?? "";

  if (format === "short") {
    return `${pc.dim(time)} ${color(severity)} ${service} ${body}`;
  }

  const parts: string[] = [];
  parts.push(`${pc.dim(time)} ${color(pc.bold(severity))} ${pc.dim("·")} ${pc.bold(service)}`);
  parts.push(`  ${body}`);

  if (log.traceId) {
    parts.push(`  ${pc.dim(`trace=${log.traceId.slice(0, 8)}`)}`);
  }

  return parts.join("\n");
}

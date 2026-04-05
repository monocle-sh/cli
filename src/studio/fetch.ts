import pc from "picocolors";
import { formatLog } from "./formatters.js";
import { StudioApi } from "./studio_api.js";

type Format = "pretty" | "json" | "short";

/**
 * Print data as formatted JSON to stdout.
 */
function printJson(data: unknown[]) {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Format a duration in milliseconds to a human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Return a picocolors colorizer based on HTTP status code range.
 */
function httpStatusColor(code: number): (s: string) => string {
  if (code >= 500) return pc.red;
  if (code >= 400) return pc.yellow;
  if (code >= 200) return pc.green;
  return pc.dim;
}

/**
 * Print a single trace to stdout in the given format.
 */
function printTrace(trace: any, format: Format) {
  const time = trace.startTime?.slice(11, 23) ?? "";
  const duration = formatDuration(trace.durationMs);

  if (format === "short") {
    const status = trace.httpStatus ? ` ${trace.httpStatus}` : "";
    console.log(
      `${pc.dim(time)} ${pc.magenta("TRC")} ${trace.serviceName ?? "unknown"} ${trace.method ?? ""} ${trace.path ?? trace.rootSpanName}${status} ${pc.dim(duration)}`,
    );
    return;
  }

  console.log(
    `${pc.dim(time)} ${pc.magenta(pc.bold("TRACE"))} ${pc.dim("·")} ${pc.bold(trace.serviceName ?? "unknown")} ${pc.dim(trace.traceId.slice(0, 8))}`,
  );

  if (trace.method) {
    const statusStr = httpStatusColor(trace.httpStatus)(String(trace.httpStatus ?? ""));
    console.log(
      `  ${pc.bold(trace.method)} ${trace.path ?? trace.rootSpanName} ${statusStr} ${pc.dim(duration)} ${pc.dim(`(${trace.spanCount} spans)`)}`,
    );
  } else {
    console.log(`  ${trace.rootSpanName} ${pc.dim(duration)}`);
  }

  console.log();
}

/**
 * Print a single error/exception to stdout in the given format.
 */
function printError(error: any, format: Format) {
  const time = error.timestamp?.slice(11, 23) ?? "";
  const service = error.serviceName ?? "unknown";

  if (format === "short") {
    console.log(
      `${pc.dim(time)} ${pc.red("ERR")} ${service} ${error.exceptionType ?? "Error"}: ${error.exceptionMessage ?? ""}`,
    );
    return;
  }

  console.log(`${pc.dim(time)} ${pc.red(pc.bold("ERROR"))} ${pc.dim("·")} ${pc.bold(service)}`);
  console.log(`  ${pc.red(error.exceptionType ?? "Error")}: ${error.exceptionMessage ?? ""}`);

  if (error.exceptionStacktrace) {
    const lines = error.exceptionStacktrace.split("\n");
    for (const line of lines.slice(0, 5)) console.log(`  ${pc.dim(line)}`);
    if (lines.length > 5) console.log(`  ${pc.dim("...")}`);
  }

  console.log(`  ${pc.dim(`trace=${error.traceId.slice(0, 8)} span=${error.spanName}`)}`);
  console.log();
}

/**
 * Fetch and print traces from the Studio server.
 */
export async function fetchTraces(options: {
  port: string;
  format: Format;
  limit: string;
  service?: string;
  traceId?: string;
}) {
  const api = new StudioApi(Number.parseInt(options.port, 10));
  const data = await api.traces({
    limit: options.limit,
    service: options.service,
    traceId: options.traceId,
  });

  if (!data.length) return console.log(pc.dim("  No traces found."));
  if (options.format === "json") return printJson(data);

  for (const trace of data) printTrace(trace, options.format);
}

/**
 * Fetch and print logs from the Studio server.
 */
export async function fetchLogs(options: {
  port: string;
  format: Format;
  limit: string;
  severity?: string;
  search?: string;
  traceId?: string;
}) {
  const api = new StudioApi(Number.parseInt(options.port, 10));
  const data = await api.logs({
    limit: options.limit,
    severity: options.severity,
    search: options.search,
    traceId: options.traceId,
  });

  if (!data.length) return console.log(pc.dim("  No logs found."));
  if (options.format === "json") return printJson(data);

  for (const log of data) {
    const output = formatLog(log, options.format);
    if (output) console.log(output);
  }
}

/**
 * Fetch and print exceptions from the Studio server.
 */
export async function fetchErrors(options: {
  port: string;
  format: Format;
  limit: string;
  traceId?: string;
}) {
  const api = new StudioApi(Number.parseInt(options.port, 10));
  const data = await api.exceptions({
    limit: options.limit,
    traceId: options.traceId,
  });

  if (!data.length) return console.log(pc.dim("  No errors found."));
  if (options.format === "json") return printJson(data);

  for (const error of data) printError(error, options.format);
}

import { consola, type ConsolaReporter } from "consola";
import { requestContext } from "./request-context.ts";
import { scrub } from "./redaction.ts";

/**
 * One structured log line.
 *
 * An error is logged by its stack when it has one, because the message alone names
 * the failure without saying where. Everything goes through `scrub` first: a token
 * that reaches stdout is in the operator's shell history and their log shipper.
 *
 * Correlation fields are spread conditionally rather than written as `undefined`, so
 * a line about a request belonging to no job carries no key claiming otherwise.
 */
export function logLine(
  entry: { date: Date; type: string; args: unknown[] },
  context: ReturnType<typeof requestContext.getStore>,
): string {
  const args = entry.args.map((arg) => scrub(arg instanceof Error ? (arg.stack ?? arg.message) : String(arg)));
  return `${JSON.stringify({
    timestamp: entry.date.toISOString(),
    level: entry.type,
    message: args.join(" "),
    ...(context
      ? {
          request_id: context.requestId,
          trace_id: context.traceId,
          span_id: context.spanId,
          ...(context.jobId === undefined ? {} : { job_id: context.jobId }),
          ...(context.grpId === undefined ? {} : { group_id: context.grpId }),
          ...(context.agentId === undefined ? {} : { agent_id: context.agentId }),
          method: context.method,
          path: context.path,
        }
      : {}),
  })}\n`;
}

export function configureStructuredLogging(): void {
  if (process.env.ORCH_LOG_FORMAT !== "json") return;
  const reporter: ConsolaReporter = {
    log(entry) {
      process.stdout.write(logLine(entry, requestContext.getStore()));
    },
  };
  consola.setReporters([reporter]);
}

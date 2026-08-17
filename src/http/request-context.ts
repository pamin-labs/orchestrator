import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  requestId: string;
  traceId: string;
  spanId: string;
  method: string;
  path: string;
  jobId?: number;
  grpId?: number | null;
  agentId?: number | null;
  signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<RequestContext>();
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestId(header?: string): string {
  return header && REQUEST_ID.test(header) ? header : crypto.randomUUID();
}

export const requestContext = storage;

export function currentRequestId(): string {
  return storage.getStore()?.requestId ?? crypto.randomUUID();
}

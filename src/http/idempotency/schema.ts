import { z } from "zod";

const IdempotencyCaller = z.union([
  z.literal("boss"),
  z.string().regex(/^agent:[0-9a-f]{24}$/, "caller must be a durable agent fingerprint"),
]);

const IdentityFields = {
  caller: IdempotencyCaller,
  route: z
    .string()
    .max(500)
    .regex(/^\/[^?#]*$/),
  key: z.string().trim().min(1).max(128),
};

/** The operator selects the exact durable caller + route + key tuple. */
export const IdempotencyIdentitySchema = z.strictObject(IdentityFields);

/** Empty query lists unresolved work; an exact tuple inspects one record. */
export const IdempotencyStatusQuery = z.union([IdempotencyIdentitySchema, z.strictObject({})]);

/** An agent may inspect only the caller fingerprint derived from its token. */
export const OwnIdempotencyStatusQuery = IdempotencyIdentitySchema.omit({ caller: true });

const IDEMPOTENCY_RECOVERY_STATUSES = [
  200, 201, 202, 203, 206, 207, 208, 226, 300, 301, 302, 303, 305, 306, 307, 308, 400, 401, 402, 403, 404, 405, 406,
  407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451, 500,
  501, 502, 503, 504, 505, 506, 507, 508, 510, 511,
] as const;
export type IdempotencyRecoveryStatus = (typeof IDEMPOTENCY_RECOVERY_STATUSES)[number];

const RecoveryStatuses: ReadonlySet<number> = new Set(IDEMPOTENCY_RECOVERY_STATUSES);

export function isIdempotencyRecoveryStatus(status: number): status is IdempotencyRecoveryStatus {
  return RecoveryStatuses.has(status);
}

export const IdempotencyRecoveryBody = z.strictObject({
  ...IdentityFields,
  status: z.number().int().min(200).max(599),
  body: z.json(),
});

export type IdempotencyIdentity = z.infer<typeof IdempotencyIdentitySchema>;
export type IdempotencyStatus = z.infer<typeof IdempotencyStatusQuery>;
export type IdempotencyRecovery = z.infer<typeof IdempotencyRecoveryBody>;

export type IdempotencyRecordState = "in_progress" | "completed" | "failed";

export type IdempotencyRecordStatus = {
  caller: string;
  key: string;
  route: string;
  state: IdempotencyRecordState;
  updated_at: number;
  replayable: boolean;
};

export type IdempotencyUnresolvedRecord = Omit<IdempotencyRecordStatus, "replayable"> & {
  recoverable: boolean;
};

export type IdempotencyUnresolvedList = {
  records: IdempotencyUnresolvedRecord[];
};

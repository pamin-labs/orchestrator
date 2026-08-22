import { z } from "zod";

const CostRowSchema = z.object({ label: z.string(), tokens: z.number() });
/**
 * One hour of burn: the key it was bucketed under, and the instant it started.
 *
 * `hour` is `MM-DD HH` in the boss's local time and it is a *key* — it groups the
 * rows and orders them. `at` is what a person reads, because only the panel knows
 * which of ten languages to write an hour in. The chart drew the key: `08-13 20`,
 * beside a trend axis that had already learned to say `13.08.` through `Intl`.
 */
const HourRowSchema = z.object({
  hour: z.string(),
  at: z.number(),
  claude: z.number(),
  codex: z.number(),
});
const AgentCostSchema = CostRowSchema.extend({
  id: z.number(),
  grpId: z.number().nullable(),
  role: z.string(),
  model: z.string(),
  runtime: z.string(),
});

export const CostReportSchema = z.object({
  delivered: z.object({ count: z.number(), tokens: z.number() }),
  byGroup: z.array(CostRowSchema.extend({ grpId: z.number() })),
  agents: z.array(AgentCostSchema),
  byRole: z.array(CostRowSchema),
  byDifficulty: z.array(CostRowSchema),
  byRuntime: z.array(CostRowSchema),
  byHour: z.array(HourRowSchema),
  total: CostRowSchema,
  cacheRatio: z.number().nullable(),
  rotations: z.object({ turns: z.number(), byReason: z.record(z.string(), z.number()) }),
});

export type CostReport = z.infer<typeof CostReportSchema>;

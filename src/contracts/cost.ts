import { z } from "zod";

const CostRowSchema = z.object({ label: z.string(), tokens: z.number() });
const HourRowSchema = z.object({
  hour: z.string(),
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

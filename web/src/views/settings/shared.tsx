import { toast } from "sonner";
import { Button, LinkButton } from "../../ui/button";
import { z } from "zod";
import { api } from "../../lib/api";
import type { InferResponseType } from "hono/client";

export const ModeSchema = z.enum(["oauth_token", "api_key", "chatgpt"]);
export type Mode = z.infer<typeof ModeSchema>;

export type AuthResponse = InferResponseType<typeof api.auth.$get, 200>;
export const AuthRowSchema: z.ZodType<AuthResponse["runtimes"][number]> = z.object({
  runtime: z.string(),
  mode: ModeSchema,
  hint: z.string(),
  baseUrl: z.string().optional(),
  updatedAt: z.number(),
});
export type AuthRow = z.infer<typeof AuthRowSchema>;

export type PreflightResponse = InferResponseType<typeof api.preflight.$get, 200>;
export const HostCheckSchema: z.ZodType<PreflightResponse["checks"][number]> = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  fix: z.string().optional(),
});
export type HostCheck = z.infer<typeof HostCheckSchema>;

/**
 * A device code, the way both flows show one.
 *
 * The code is the interaction, not the link: the link alone opens a page asking
 * for a code the boss does not have. Large, monospace, wide tracking because it
 * is typed into another window character by character, and one click from the
 * clipboard.
 */
export function DeviceCode({ code, url, go }: { code: string; url: string; go: string }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 rounded-md bg-sunk px-3 py-2.5">
      <code className="font-mono text-[1.375rem] leading-none font-semibold tracking-[0.3em] select-all">{code}</code>
      <Button
        size="sm"
        variant="quiet"
        onClick={() => {
          void navigator.clipboard.writeText(code);
          toast.success("登录码复制好了");
        }}
      >
        复制
      </Button>
      <span className="grow" />
      <LinkButton href={url} className="px-2 py-0.5 text-[0.75rem]">
        {go}
      </LinkButton>
    </div>
  );
}

import { toast } from "sonner";
import { Button, LinkButton } from "../../ui/button";
import { z } from "zod";
import { api } from "../../shared/api";
import type { InferResponseType } from "hono/client";

export const ModeSchema = z.enum(["oauth_token", "api_key", "chatgpt"]);
export type Mode = z.infer<typeof ModeSchema>;

export type AuthResponse = InferResponseType<typeof api.auth.$get, 200>;
export type AuthRow = AuthResponse["runtimes"][number];
export const AuthRowSchema = z
  .object({
    runtime: z.string(),
    mode: ModeSchema,
    hint: z.string(),
    baseUrl: z.string().optional(),
    updatedAt: z.number(),
  })
  .transform(
    ({ baseUrl, ...row }): AuthRow => ({
      ...row,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    }),
  );

export type PreflightResponse = InferResponseType<typeof api.preflight.$get, 200>;
export type HostCheck = PreflightResponse["checks"][number];
export const HostCheckSchema = z
  .object({
    name: z.string(),
    ok: z.boolean(),
    detail: z.string(),
    fix: z.string().optional(),
  })
  .transform(
    ({ fix, ...check }): HostCheck => ({
      ...check,
      ...(fix !== undefined ? { fix } : {}),
    }),
  );

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
      <code className="font-mono text-figure leading-none font-semibold tracking-[0.3em] select-all">{code}</code>
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
      <LinkButton href={url} className="px-2 py-0.5 text-secondary">
        {go}
      </LinkButton>
    </div>
  );
}

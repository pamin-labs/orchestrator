import { ComposerDialog } from "../composer/view";
import { api, mutate } from "../../shared/api";
import { t } from "@lingui/core/macro";

/**
 * Dropping an idea.
 *
 * One line was too short — an idea is two or three sentences and a screenshot of
 * the bug says more than any of them — but there is nothing special about this box:
 * it is the shared composer, the same one used for talking to a group or saying why
 * something is being sent back.
 */
export function NewRequirement({
  open,
  onOpenChange,
  projectId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: number;
  onDone: () => void;
}) {
  return (
    <ComposerDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t`New requirement`}
      hint={t`Just describe what you need. A plan card will be generated for approval before any code is written.`}
      placeholder={t`Example: Add a "Remember me" checkbox to the login page; once checked, stay logged in for 30 days.
Drag in screenshots or designs, or paste. Cmd+Enter to submit`}
      submit={t`Submit`}
      rows={6}
      onSubmit={async ({ text, attachments }) => {
        const r = await mutate(api.ideas.$post({ json: { project_id: projectId, text, attachments } }));
        if (r.ok) onDone();
        return r.ok;
      }}
    />
  );
}

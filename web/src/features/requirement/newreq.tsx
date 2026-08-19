import { useTranslation } from "react-i18next";
import { ComposerDialog } from "../composer/view";
import { api, mutate } from "../../shared/api";

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
  const { t } = useTranslation();
  return (
    <ComposerDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("requirement.newreq.title", "新需求")}
      hint={t("requirement.newreq.hint", "说清要什么就够。产出计划卡待批，批准前不写代码。")}
      placeholder={t(
        "requirement.newreq.placeholder",
        "例：登录页加「记住我」，勾了之后 30 天不用重新登录。\n截图、设计稿拖进来或粘贴。⌘Enter 提交",
      )}
      submit={t("requirement.newreq.submit", "提交")}
      rows={6}
      onSubmit={async ({ text, attachments }) => {
        const r = await mutate(api.ideas.$post({ json: { project_id: projectId, text, attachments } }));
        if (r.ok) onDone();
        return r.ok;
      }}
    />
  );
}

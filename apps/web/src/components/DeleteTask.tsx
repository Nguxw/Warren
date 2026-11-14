import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../api.ts";
import { useI18n } from "../context.tsx";
import { Trash } from "../icons.tsx";

/**
 * Asks before deleting a task, saying what goes (its conversation and workspace files) and what
 * stays (files saved elsewhere, published branches). The delete button takes the focus, so Enter
 * confirms here and never reaches a text box behind the dialog; Esc cancels.
 */
export function DeleteTask(props: {
  task: { id: string; title: string; status: string };
  onClose(): void;
  onDeleted(id: string): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.remove(props.task.id),
    onSuccess: () => {
      for (const key of ["task", "events", "files", "diff"]) {
        client.removeQueries({ queryKey: [key, props.task.id] });
      }
      client.invalidateQueries({ queryKey: ["tasks"] });
      props.onDeleted(props.task.id);
    },
  });
  const { onClose } = props;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay">
      <button
        type="button"
        className="backdrop"
        aria-label={t("delete.cancel")}
        onClick={onClose}
      />
      <div className="confirm" role="alertdialog" aria-modal="true" aria-label={t("delete.title")}>
        <span className="confirm-icon">
          <Trash size={20} />
        </span>
        <h2>{t("delete.title")}</h2>
        <p className="confirm-name">{props.task.title}</p>
        <p className="muted">
          {props.task.status !== "ended" && `${t("delete.running")} `}
          {t("delete.body")}
        </p>
        {remove.error && <p className="form-error">{remove.error.message}</p>}
        <footer>
          <button type="button" className="button ghost" onClick={onClose}>
            {t("delete.cancel")}
          </button>
          <button
            type="button"
            className="button danger-solid"
            // biome-ignore lint/a11y/noAutofocus: a confirmation dialog focuses its action
            autoFocus
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? t("delete.deleting") : t("delete.confirm")}
          </button>
        </footer>
      </div>
    </div>
  );
}

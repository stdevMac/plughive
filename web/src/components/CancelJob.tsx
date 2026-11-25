// Stopping a job asks first: the provider may already have done (and billed)
// part of the work. "Keep it running" is focused, and Enter does not stop it.
import { type ReactNode, useState } from "react";
import { t } from "../i18n";
import { api, errorMessage } from "../lib/api";
import type { JobView } from "../lib/types";
import { Dialog } from "./Dialog";
import { useToast } from "./Toast";
import { Button } from "./ui";

export function useCancelJob(onDone: (j: JobView) => void): {
  ask: (job: Pick<JobView, "job_id" | "tool">) => void;
  busy: string | null;
  dialog: ReactNode;
} {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<Pick<JobView, "job_id" | "tool"> | null>(null);

  const stop = async (id: string) => {
    setAsking(null);
    setBusy(id);
    try {
      const r = await api.post<{ job: JobView }>(`/api/jobs/${encodeURIComponent(id)}/cancel`, {});
      onDone(r.job);
      toast.ok(t("jobs.cancel.stopped"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const dialog = (
    <Dialog
      open={asking !== null}
      onClose={() => setAsking(null)}
      role="alertdialog"
      size="sm"
      title={t("jobs.cancel.title")}
      footer={
        <>
          <Button variant="secondary" data-autofocus onClick={() => setAsking(null)}>
            {t("jobs.cancel.keep")}
          </Button>
          <Button variant="danger" icon="stop" onClick={() => asking && void stop(asking.job_id)}>
            {t("jobs.cancel.confirm")}
          </Button>
        </>
      }
    >
      <p>
        <span className="mono">{asking?.tool}</span>
        {t("jobs.cancel.body")}
      </p>
    </Dialog>
  );

  return { ask: setAsking, busy, dialog };
}

import { changeStatus, statusLabel, statusLetter, type ChangeStatus } from "../diff";
import type { FileDiff } from "../types";

export default function StatusBadge({
  entry,
  status,
}: {
  entry?: FileDiff;
  status?: ChangeStatus;
}) {
  const resolved = status ?? (entry ? changeStatus(entry) : "modified");
  return (
    <span
      className={`status-badge ${resolved}`}
      title={statusLabel(resolved)}
      aria-label={statusLabel(resolved)}
    >
      {statusLetter(resolved)}
    </span>
  );
}

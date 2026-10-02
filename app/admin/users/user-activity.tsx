"use client";

import { useId, useState } from "react";
import { activityLabel, exactSydneyDate } from "../../../lib/admin-directory";
import { useDirectoryActivity } from "./directory-list";
import styles from "./user-activity.module.css";

export default function UserActivity({ email, initialLastActiveAt }: { email: string; initialLastActiveAt: string | null }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const { lastActiveAt, now } = useDirectoryActivity(email, initialLastActiveAt);
  const label = now === null && lastActiveAt
    ? { text: "Activity recorded", tone: "neutral" as const }
    : activityLabel(lastActiveAt, now ?? 0);
  return (
    <span className={`${styles.activity} ${styles[label.tone]}`}>
      <button type="button" aria-expanded={expanded} aria-controls={`${id}-timestamp`}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); setExpanded((open) => !open); }}
        onKeyDown={(event) => event.stopPropagation()}>
        {label.text}
      </button>
      <time id={`${id}-timestamp`} dateTime={lastActiveAt || undefined} hidden={!expanded}>
        {exactSydneyDate(lastActiveAt)}
      </time>
    </span>
  );
}

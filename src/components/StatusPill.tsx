import type { Member } from "../lib/types";

const LABEL = { active: "Active", due: "Due", lapsed: "Lapsed" } as const;
const ICON = { active: "●", due: "▲", lapsed: "○" } as const;

export function StatusPill({ member, soonDays = 7 }: { member: Member; soonDays?: number }) {
  const soon = member.status === "active" && member.daysLeft !== null && member.daysLeft <= soonDays;
  const tone = soon ? "warn" : member.status === "active" ? "good" : member.status === "due" ? "bad" : "neutral";
  return (
    <span className={`pill ${tone}`}>
      <span aria-hidden="true">{soon ? "◆" : ICON[member.status]}</span> {soon ? "Renewing soon" : LABEL[member.status]}
    </span>
  );
}

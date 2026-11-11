// Human attention is a cost. Count the actions a person had to take for a
// campaign, so CLOSE.md and the History tab can compare it with the value.
export function attentionOf(events = []) {
  let approvals = 0;
  let answers = 0;
  let reviews = 0;
  let cleanups = 0;
  for (const event of events) {
    if (event.type === "campaign.approved" && !event.data?.automatic) approvals++;
    else if (event.type === "inbox.answered" && ["question", "failure"].includes(event.data?.kind)) answers++;
    else if (event.type === "inbox.answered" && event.data?.kind === "review") reviews++;
    else if (event.type === "branches.cleaned") cleanups++;
  }
  return { approvals, answers, reviews, cleanups, total: approvals + answers + reviews + cleanups };
}

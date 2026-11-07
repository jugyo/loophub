// The answer form under a Workflow run's human escalation comment: its options as radio buttons
// and a submit. An answered escalation keeps the chosen option checked; a superseded one (its run
// escalated again since) is shown disabled. Either way it can no longer be submitted.

import { useState } from "react";
import type { CommentEscalation } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function EscalationAnswer({
  commentId,
  escalation,
  submitting,
  onSubmit,
}: {
  commentId: number;
  escalation: CommentEscalation;
  submitting: boolean;
  onSubmit: (option: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const answered = escalation.answer !== null;
  const closed = answered || escalation.superseded;
  const checked = answered ? escalation.answer : selected;
  const name = `escalation-${commentId}`;
  return (
    <section
      data-debug-component="EscalationAnswer"
      aria-label={`Escalation options for PR comment ${commentId}`}
      className={`mt-3 rounded-md border px-3 py-2 ${closed ? "bg-muted/40" : ""}`}
    >
      {closed && (
        <div className="mb-2">
          {answered ? (
            <Badge tone="review-passed">Answered</Badge>
          ) : (
            <Badge tone="closed">Superseded by a newer escalation</Badge>
          )}
        </div>
      )}
      {escalation.options.length > 0 && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (selected && !closed) onSubmit(selected);
          }}
        >
          <div role="radiogroup" aria-label="Escalation options">
            {escalation.options.map((option, index) => (
              <div key={option} className="flex items-start gap-2 py-1">
                <input
                  id={`${name}-${index}`}
                  type="radio"
                  name={name}
                  value={option}
                  checked={checked === option}
                  disabled={closed || submitting}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                  onChange={() => setSelected(option)}
                />
                <label
                  htmlFor={`${name}-${index}`}
                  className={`text-sm ${closed ? "text-muted-foreground" : ""}`}
                >
                  {option}
                </label>
              </div>
            ))}
          </div>
          {!closed && (
            <Button
              type="submit"
              size="sm"
              className="mt-2"
              disabled={!selected || submitting}
            >
              Submit answer
            </Button>
          )}
        </form>
      )}
    </section>
  );
}

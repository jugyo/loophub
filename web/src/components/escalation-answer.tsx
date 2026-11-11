// The answer form under a Workflow run's human escalation comment: its options as radio buttons,
// a last "Other" choice with a free-text answer, and a submit. An answered escalation keeps the
// chosen option checked and read-only — not disabled, since a browser greys a disabled radio until
// its checked dot is barely visible, even once a newer escalation supersedes it; a free answer is
// shown the same way, as "Other" checked with its text read-only. An unanswered one superseded by
// a newer escalation (its run escalated again since) is shown disabled. Either way it can no
// longer be submitted.

import { useState } from "react";
import type { CommentEscalation } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// The radio value of the free-text choice. Not a string, so no option text can collide with it.
const OTHER = Symbol("other");

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
  const [selected, setSelected] = useState<string | typeof OTHER | null>(null);
  const [freeText, setFreeText] = useState("");
  const answered = escalation.answer !== null;
  const closed = answered || escalation.superseded;
  const freeAnswer =
    escalation.answer !== null &&
    !escalation.options.includes(escalation.answer)
      ? escalation.answer
      : null;
  const checked = answered
    ? freeAnswer !== null
      ? OTHER
      : escalation.answer
    : selected;
  const locked = closed || submitting;
  const submitted = selected === OTHER ? freeText.trim() : selected;
  const name = `escalation-${commentId}`;
  const choices: { value: string | typeof OTHER; label: string }[] = [
    ...escalation.options.map((option) => ({ value: option, label: option })),
    { value: OTHER, label: "Other" },
  ];
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
            if (submitted && !closed) onSubmit(submitted);
          }}
        >
          <div
            role="radiogroup"
            aria-label="Escalation options"
            aria-readonly={locked}
          >
            {choices.map(({ value, label }, index) => (
              <div key={label} className="flex items-start gap-2 py-1">
                <input
                  id={`${name}-${index}`}
                  type="radio"
                  name={name}
                  value={typeof value === "string" ? value : ""}
                  checked={checked === value}
                  disabled={closed && !answered}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                  onChange={() => {
                    if (!locked) setSelected(value);
                  }}
                />
                <label
                  htmlFor={`${name}-${index}`}
                  className={`text-sm ${closed && checked !== value ? "text-muted-foreground" : ""}`}
                >
                  {label}
                </label>
              </div>
            ))}
          </div>
          {(checked === OTHER || !closed) && (
            <textarea
              aria-label="Free answer"
              placeholder="Write your own answer"
              rows={2}
              value={freeAnswer ?? freeText}
              readOnly={locked}
              disabled={closed && !answered}
              onFocus={() => {
                if (!locked) setSelected(OTHER);
              }}
              onChange={(event) => {
                if (locked) return;
                setSelected(OTHER);
                setFreeText(event.target.value);
              }}
              className="mt-1 ml-6 block w-[calc(100%-1.5rem)] min-w-0 rounded-md border bg-background p-2 text-sm"
            />
          )}
          {!closed && (
            <Button
              type="submit"
              size="sm"
              className="mt-2"
              disabled={!submitted || submitting}
            >
              Submit answer
            </Button>
          )}
        </form>
      )}
    </section>
  );
}

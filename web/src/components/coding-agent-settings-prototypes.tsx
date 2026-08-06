// Prototype variants of the application-level "Coding agent" settings UI (#41). These are throwaway
// design explorations shown in the UI catalog (/__ui) for comparison — NOT the live Settings screen
// (settings-page.tsx / repo-settings-page.tsx). They only hold local UI state; they never persist or
// call RPCs. Each card pairs a short intent note with an interactive mock so reviewers can feel the
// density and the selected-agent ↔ settings relationship before deciding on a direction.
//
// Structural labels (Coding agent, Default model & effort, Model, Effort, override On/Off…) mirror
// the terms already used by the real screens so the prototypes stay comparable to today's UI. The
// per-card intent notes are Japanese (this run's review language).
//
// NOTE: this module is deliberately unrouted / not referenced by the app shell. It exists only so the
// catalog can include it; production switching is explicitly out of scope for #41.

import { Check, ChevronsUpDown } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { CodingAgent } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CODING_AGENT_LABELS,
  EFFORT_SUGGESTIONS,
  MODEL_SUGGESTIONS,
} from "@/lib/agent-models";
import { cn } from "@/lib/utils";
import {
  CODING_AGENTS,
  isCodingAgent,
  RUNTIMES,
} from "../../../core/runtimes.ts";

// The persisted "didn't set it" value for model/effort. Mirrors the real settings semantics: empty
// string means "use the runtime's default" (stored as null core-side, rendered as "" on the wire).
const EMPTY = "";

// A single agent's default model + effort (its registry defaults), used to seed the per-prototype
// current value so each mock reads like a real config.
function agentDefault(agent: CodingAgent): { model: string; effort: string } {
  const runtime = RUNTIMES[agent];
  return { model: runtime.defaultModel, effort: runtime.defaultEffort };
}

function comboValue(model: string, effort: string): string {
  return `${model}::${effort}`;
}

function comboLabel(model: string, effort: string): string {
  if (!model && !effort) return "Default";
  if (!model) return `Default — ${effort}`;
  if (!effort) return `${model} — default`;
  return `${model} — ${effort}`;
}

// The full model × effort option set for an agent (the same combos the real Settings picker uses), so
// a selection always resolves to a valid pair. A persisted value outside the suggestion lists is
// injected as a leading option so an existing config stays visible (#682).
function comboOptions(
  agent: CodingAgent,
  current: { model: string; effort: string },
): { model: string; effort: string }[] {
  const efforts = EFFORT_SUGGESTIONS[agent].length
    ? EFFORT_SUGGESTIONS[agent]
    : [EMPTY];
  const combos = MODEL_SUGGESTIONS[agent].flatMap((model) =>
    efforts.map((effort) => ({ model, effort })),
  );
  const hasCurrent = combos.some(
    (c) =>
      comboValue(c.model, c.effort) ===
      comboValue(current.model, current.effort),
  );
  return hasCurrent ? combos : [current, ...combos];
}

// A single-field dropdown (a model, an effort, or a runtime). The first item is "Default" (empty
// = "use the runtime's default"). Used by the table prototype (案 B) and the repo-override prototype.
function FieldDropdown({
  ariaLabel,
  value,
  options,
  portalContainer,
  onSelect,
  showDefault = true,
  placeholder = "Default",
}: {
  ariaLabel: string;
  value: string;
  options: { value: string; label: string }[];
  portalContainer: HTMLElement | null;
  onSelect: (value: string) => void;
  // Whether the "Default" (empty) item is offered. Meaningful for model/effort ("use the runtime's
  // default") but NOT for agent/runtime — an empty runtime would crash the lookup. Callers that
  // select an enum must turn it off so "" can never reach the handler.
  showDefault?: boolean;
  // Fallback label for an empty value. Prototype B drops the "Default" wording (human feedback:
  // confusing there) and shows an en dash instead for agents without an effort.
  placeholder?: string;
}) {
  const selected = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-label={ariaLabel}
          className="w-full justify-between gap-2 border bg-background px-2.5 text-left font-normal shadow-sm"
        >
          <span className="truncate">
            {selected ? selected.label : value || placeholder}
          </span>
          <ChevronsUpDown
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        portalContainer={portalContainer}
        className="max-h-[min(20rem,calc(100vh-5rem))] w-[var(--radix-dropdown-menu-trigger-width)] min-w-48 overflow-y-auto"
      >
        {showDefault ? (
          <DropdownMenuItem
            onSelect={() => onSelect(EMPTY)}
            aria-current={value === EMPTY ? "true" : undefined}
            className={cn(
              "justify-between",
              value === EMPTY && "bg-accent text-accent-foreground",
            )}
          >
            <span>Default</span>
            {value === EMPTY ? <DropdownMenuItemIndicator /> : null}
          </DropdownMenuItem>
        ) : null}
        {options.map((o) => {
          const selectedOpt = value === o.value;
          return (
            <DropdownMenuItem
              key={o.value}
              onSelect={() => onSelect(o.value)}
              aria-current={selectedOpt ? "true" : undefined}
              className={cn(
                "justify-between",
                selectedOpt && "bg-accent text-accent-foreground",
              )}
            >
              <span className="min-w-0 truncate">{o.label}</span>
              {selectedOpt ? <DropdownMenuItemIndicator /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The model × effort combo picker, the same control the real Application screen uses (a single
// dropdown whose options are valid model+effort pairs) — reused by the selected-agent (案 A) and
// single-dropdown (案 C) prototypes so the difference stays purely in the layout, not the control.
function ModelEffortDropdown({
  agent,
  value,
  portalContainer,
  onSave,
}: {
  agent: CodingAgent;
  value: { model: string; effort: string };
  portalContainer: HTMLElement | null;
  onSave: (model: string, effort: string) => void;
}) {
  const currentValue = comboValue(value.model, value.effort);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          aria-label={`Default model and effort (${CODING_AGENT_LABELS[agent]})`}
          title={comboLabel(value.model, value.effort)}
          className="w-full max-w-md justify-between border bg-background px-3 text-left font-normal shadow-sm"
        >
          <span className="min-w-0 truncate">
            {comboLabel(value.model, value.effort)}
          </span>
          <ChevronsUpDown
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        portalContainer={portalContainer}
        className="max-h-[min(24rem,calc(100vh-5rem))] w-[var(--radix-dropdown-menu-trigger-width)] min-w-72 overflow-y-auto"
      >
        {comboOptions(agent, value).map((o) => {
          const valueKey = comboValue(o.model, o.effort);
          const selected = valueKey === currentValue;
          return (
            <DropdownMenuItem
              key={valueKey}
              onSelect={() => {
                if (selected) return;
                onSave(o.model, o.effort);
              }}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "justify-between",
                selected && "bg-accent text-accent-foreground",
              )}
            >
              <span className="min-w-0 truncate">
                {comboLabel(o.model, o.effort)}
              </span>
              {selected ? <DropdownMenuItemIndicator /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PrototypeCard({
  index,
  title,
  intent,
  children,
  selected = false,
}: {
  index: string;
  title: string;
  intent: string;
  children: ReactNode;
  // Marks the direction the human reviewer picked (case B), so the catalog records the decision for
  // the follow-up implementation issue instead of leaving it only in PR comments.
  selected?: boolean;
}) {
  return (
    <section
      data-debug-component={`CodingAgentPrototype${index}`}
      className="rounded-md border bg-card p-5 text-card-foreground"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">
            案 {index} — {title}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{intent}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {selected ? <Badge tone="open">selected</Badge> : null}
          <Badge tone="agent">prototype</Badge>
        </div>
      </div>
      <div className="rounded-md border bg-background p-4">{children}</div>
    </section>
  );
}

// A small round marker standing in for a radio/check indicator (used by the table prototype).
function DefaultMarker({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border",
        active ? "border-primary" : "border-border",
      )}
      aria-hidden="true"
    >
      {active ? <span className="size-2 rounded-full bg-primary" /> : null}
    </span>
  );
}

// 案 A (selected-agent-first): keep the full radio list so every agent is always visible, but render
// the model/effort editor only for the selected agent. Each row shows that agent's current
// model/effort as a compact summary so the non-edited agents still communicate their state without
// stacking five dropdowns.
function PrototypeARadio({
  portalContainer,
}: {
  portalContainer: HTMLElement | null;
}) {
  const [selected, setSelected] = useState<CodingAgent>("claude-code");
  const [value, setValue] = useState(() => agentDefault("claude-code"));

  function selectAgent(agent: CodingAgent) {
    setSelected(agent);
    setValue(agentDefault(agent));
  }

  return (
    <PrototypeCard
      index="A"
      title="選択中の agent だけ展開する"
      intent="ラジオの列は縦に長いままにする代わりに、model/effort の編集は選択中の agent の 1 ブロックだけに絞る。各行に現在の summary を添え、非選択 agent の状態も縦に埋めずに読める。"
    >
      <div className="max-w-md">
        <p className="text-sm font-medium">Coding agent</p>
        <p className="mt-1 text-sm text-muted-foreground">
          デフォルトはコードを運転する agent の設定です。（mock）
        </p>
        <div
          role="radiogroup"
          aria-label="Coding agent (prototype A)"
          className="mt-3 rounded-md border"
        >
          {CODING_AGENTS.map((agent) => {
            const active = selected === agent;
            const summary = agentDefault(agent);
            return (
              <button
                key={agent}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={CODING_AGENT_LABELS[agent]}
                onClick={() => selectAgent(agent)}
                className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent hover:text-accent-foreground"
              >
                <Check
                  className={`mt-0.5 size-4 shrink-0 ${active ? "" : "invisible"}`}
                  aria-hidden="true"
                />
                <span className="flex flex-1 items-center justify-between gap-3">
                  <span>{CODING_AGENT_LABELS[agent]}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {comboLabel(summary.model, summary.effort)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 border-l-2 pl-4">
          <h4 className="text-xs font-medium text-muted-foreground">
            {CODING_AGENT_LABELS[selected]} — Default model & effort
          </h4>
          <div className="mt-1">
            <ModelEffortDropdown
              agent={selected}
              value={value}
              portalContainer={portalContainer}
              onSave={(model, effort) => setValue({ model, effort })}
            />
          </div>
        </div>
      </div>
    </PrototypeCard>
  );
}

// 案 B (all-agents table): replace the nested radio + per-agent blocks with a compact table where
// each row is one agent and the columns are the default marker, Agent, Model, and Effort. Every
// agent's config is comparable on a single horizontal line and there is no vertical nesting at all.
function PrototypeBTable({
  portalContainer,
}: {
  portalContainer: HTMLElement | null;
}) {
  const [defaultAgent, setDefaultAgent] = useState<CodingAgent>("claude-code");
  const [cells, setCells] = useState<
    Record<CodingAgent, { model: string; effort: string }>
  >(
    () =>
      Object.fromEntries(
        CODING_AGENTS.map((a) => [a, agentDefault(a)]),
      ) as Record<CodingAgent, { model: string; effort: string }>,
  );

  return (
    <PrototypeCard
      index="B"
      title="全 agent を 1 行テーブルで比較する"
      intent="横 1 行 = 1 agent にまとめ、Model / Effort を列として置く。全 agent の設定を一度に比較でき、ネストの折り返しがなくなる。列は必要な分だけ残し、agent が増えても縦に崩れにくい。"
      selected
    >
      <div className="max-w-xl">
        <p className="text-sm font-medium">Coding agent</p>
        <p className="mt-1 text-sm text-muted-foreground">
          デフォルトはコードを運転する agent の設定です。（mock）
        </p>
        <div className="mt-3 space-y-1.5">
          {/* header row — the first column carries no label: the marker itself communicates "default
              agent", and the word "Default" was dropped per human feedback (confusing in a table
              where every cell already shows its current value). */}
          <div className="grid grid-cols-[3rem_minmax(0,1fr)_10rem_9rem] items-center gap-3 pr-1 text-xs font-medium text-muted-foreground">
            <span aria-hidden="true" />
            <span>Agent</span>
            <span>Model</span>
            <span>Effort</span>
          </div>
          {CODING_AGENTS.map((agent) => {
            const isDefault = defaultAgent === agent;
            return (
              <div
                key={agent}
                className="grid grid-cols-[3rem_minmax(0,1fr)_10rem_9rem] items-center gap-3"
              >
                <button
                  type="button"
                  aria-label={`${CODING_AGENT_LABELS[agent]} — default`}
                  className="flex w-fit items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => setDefaultAgent(agent)}
                >
                  <DefaultMarker active={isDefault} />
                </button>
                <span className="min-w-0 truncate text-sm">
                  {CODING_AGENT_LABELS[agent]}
                </span>
                <FieldDropdown
                  ariaLabel={`${CODING_AGENT_LABELS[agent]} model (prototype B)`}
                  value={cells[agent].model}
                  options={MODEL_SUGGESTIONS[agent].map((m) => ({
                    value: m,
                    label: m,
                  }))}
                  portalContainer={portalContainer}
                  showDefault={false}
                  onSelect={(model) =>
                    setCells((c) => ({ ...c, [agent]: { ...c[agent], model } }))
                  }
                />
                <FieldDropdown
                  ariaLabel={`${CODING_AGENT_LABELS[agent]} effort (prototype B)`}
                  value={cells[agent].effort}
                  options={EFFORT_SUGGESTIONS[agent].map((e) => ({
                    value: e,
                    label: e,
                  }))}
                  portalContainer={portalContainer}
                  showDefault={false}
                  placeholder="—"
                  onSelect={(effort) =>
                    setCells((c) => ({
                      ...c,
                      [agent]: { ...c[agent], effort },
                    }))
                  }
                />
              </div>
            );
          })}
        </div>
      </div>
    </PrototypeCard>
  );
}

// 案 C: collapse the agent pick to a single dropdown (no radio list) and keep one model/effort block
// under it. The smallest vertical footprint and the most linear to scan; it presumes the default agent
// matters more than comparing all candidates side by side.
function PrototypeCDropdown({
  portalContainer,
}: {
  portalContainer: HTMLElement | null;
}) {
  const [agent, setAgent] = useState<CodingAgent>("claude-code");
  const [value, setValue] = useState(() => agentDefault("claude-code"));

  // Guard against an empty/unknown value reaching RUNTIMES[""] (the agent dropdown no longer offers
  // "Default", but a stray "" must resolve to a real runtime instead of crashing the catalog).
  function selectAgent(next: string) {
    const resolved: CodingAgent = isCodingAgent(next) ? next : "claude-code";
    setAgent(resolved);
    setValue(agentDefault(resolved));
  }

  const agentOptions = CODING_AGENTS.map((a) => ({
    value: a,
    label: CODING_AGENT_LABELS[a],
  }));

  return (
    <PrototypeCard
      index="C"
      title="select 1 つにまとめる"
      intent="agent の選択をドロップダウン 1 つに置き、下にその agent の model/effort ブロックを 1 つだけ置く。縦方向の長さは最小で、agent 数が増えても UI が崩れない。"
    >
      <div className="max-w-md">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">
            Default coding agent
          </span>
          <FieldDropdown
            ariaLabel="Default coding agent (prototype C)"
            value={agent}
            options={agentOptions}
            portalContainer={portalContainer}
            onSelect={selectAgent}
            showDefault={false}
          />
        </label>
        <div className="mt-4 border-l-2 pl-4">
          <h4 className="text-xs font-medium text-muted-foreground">
            {CODING_AGENT_LABELS[agent]} — Default model & effort
          </h4>
          <div className="mt-1">
            <ModelEffortDropdown
              agent={agent}
              value={value}
              portalContainer={portalContainer}
              onSave={(model, effort) => setValue({ model, effort })}
            />
          </div>
        </div>
      </div>
    </PrototypeCard>
  );
}

// 案 D (repo override, drawing on the table language of 案 B): the per-repo override section would
// reuse the same row table so the application and per-repo screens feel like one system. While the
// override is off, the effective config a run would launch with is shown inline; switching it on
// reveals a single Runtime / Model / Effort row to edit.
function PrototypeDRepoOverride({
  portalContainer,
}: {
  portalContainer: HTMLElement | null;
}) {
  const [override, setOverride] = useState(true);
  const [runtime, setRuntime] = useState<CodingAgent>("claude-code");
  const [value, setValue] = useState(() => agentDefault("claude-code"));

  const runtimeOptions = CODING_AGENTS.map((a) => ({
    value: a,
    label: CODING_AGENT_LABELS[a],
  }));

  function selectRuntime(next: string) {
    const resolved: CodingAgent = isCodingAgent(next) ? next : "claude-code";
    setRuntime(resolved);
    setValue(agentDefault(resolved));
  }

  return (
    <PrototypeCard
      index="D"
      title="repo override も同じテーブル言語に"
      intent="repo 側の override を案 の table と同じ行言語で描く。アプリ側と repo 側で見た目・操作を揃えることで、両設定の関係が読みやすくなる。"
    >
      <div className="max-w-lg">
        <p className="text-sm text-muted-foreground">
          アプリ側 Coding agent 設定をこの repo の run で上書き（mock, repo
          override）。
        </p>
        <div
          role="radiogroup"
          aria-label="Override application Coding agent settings (prototype D)"
          className="mt-3 rounded-md border"
        >
          {[
            { value: false, label: "Off (use application settings)" },
            { value: true, label: "On (override for this repo)" },
          ].map((o) => {
            const active = override === o.value;
            return (
              <button
                key={String(o.value)}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setOverride(o.value)}
                className="flex w-full items-start gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent hover:text-accent-foreground"
              >
                <Check
                  className={`mt-0.5 size-4 shrink-0 ${active ? "" : "invisible"}`}
                  aria-hidden="true"
                />
                <span className="flex flex-col">
                  <span>{o.label}</span>
                  {active ? (
                    <span className="text-xs text-muted-foreground">
                      effective — {runtime} · {value.model} ·{" "}
                      {value.effort || "default"}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>

        {override ? (
          <div className="mt-3 space-y-1.5">
            <div className="grid grid-cols-[minmax(0,1fr)_10rem_9rem] items-center gap-3 pr-1 text-xs font-medium text-muted-foreground">
              <span>Runtime</span>
              <span>Model</span>
              <span>Effort</span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_10rem_9rem] items-center gap-3">
              <FieldDropdown
                ariaLabel="Runtime (prototype D)"
                value={runtime}
                options={runtimeOptions}
                portalContainer={portalContainer}
                onSelect={selectRuntime}
                showDefault={false}
              />
              <FieldDropdown
                ariaLabel="Model (prototype D)"
                value={value.model}
                options={MODEL_SUGGESTIONS[runtime].map((m) => ({
                  value: m,
                  label: m,
                }))}
                portalContainer={portalContainer}
                onSelect={(model) => setValue((v) => ({ ...v, model }))}
              />
              <FieldDropdown
                ariaLabel="Effort (prototype D)"
                value={value.effort}
                options={EFFORT_SUGGESTIONS[runtime].map((e) => ({
                  value: e,
                  label: e,
                }))}
                portalContainer={portalContainer}
                onSelect={(effort) => setValue((v) => ({ ...v, effort }))}
              />
            </div>
          </div>
        ) : null}
      </div>
    </PrototypeCard>
  );
}

export function CodingAgentSettingsPrototypes({
  portalContainer,
}: {
  portalContainer: HTMLElement | null;
}) {
  return (
    <section
      data-debug-component="CodingAgentSettingsPrototypes"
      aria-label="Coding agent settings prototypes"
      className="space-y-6"
    >
      <div className="rounded-md border bg-card p-5 text-card-foreground">
        <div className="flex items-center gap-2">
          <Badge tone="agent">exploration</Badge>
          <h3 className="text-base font-semibold">
            Coding agent 設定 UI — プロトタイプ
          </h3>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          アプリケーション Settings の Coding agent
          ブロックに対する比較用プロトタイプです。「縦に長い radio + ネストした
          model/effort」をどう情報設計し直すかを、最低 2 案で確認します（この
          run
          の成果物は仮説の提示に留まり、本実装の選定とは結びつけません）。各案は操作できる状態そのままで、永続化や
          RPC は行いません。
        </p>
      </div>
      <PrototypeARadio portalContainer={portalContainer} />
      <PrototypeBTable portalContainer={portalContainer} />
      <PrototypeCDropdown portalContainer={portalContainer} />
      <PrototypeDRepoOverride portalContainer={portalContainer} />
    </section>
  );
}

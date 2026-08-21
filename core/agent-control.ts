export interface AgentExecutionTarget {
  provider: string;
  targetId: string;
  context: string | null;
}

export interface AgentControl {
  inputText(target: AgentExecutionTarget, text: string): Promise<void>;
  close(target: AgentExecutionTarget): Promise<void>;
}

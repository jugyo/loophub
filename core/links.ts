// GitHub-compatible closing keywords in PR body (secondary link path).
const CLOSING_RE =
  /(?:^|\s)(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/i;

export function parseClosingIssueNumber(body: string): number | null {
  const m = body.match(CLOSING_RE);
  return m ? Number(m[1]) : null;
}

export function linkedRef(repo: { owner: string; name: string }, kind: "issues" | "pulls", number: number) {
  return {
    number,
    html_url: `/repos/${repo.owner}/${repo.name}/${kind}/${number}`,
  };
}

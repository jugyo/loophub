export function linkedRef(
  repo: { owner: string; name: string },
  kind: "issues" | "pulls",
  number: number,
) {
  return {
    number,
    html_url: `/repos/${repo.owner}/${repo.name}/${kind}/${number}`,
  };
}

/** The fragment that names one PR conversation comment on the PR screen. */
export function commentAnchor(commentId: number): string {
  return `comment-${commentId}`;
}

/** The Web UI link that opens a PR scrolled to its conversation comment `commentId`. */
export function pullCommentPermalink(
  repo: { owner: string; name: string },
  number: number,
  commentId: number,
): string {
  return `/r/${repo.owner}/${repo.name}/pulls/${number}#${commentAnchor(commentId)}`;
}

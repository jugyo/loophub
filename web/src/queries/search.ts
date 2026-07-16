import { useQuery } from "@tanstack/react-query";
import { searchIssuesAndPulls } from "@/api/client";

export function useRepositorySearch(
  owner: string,
  repo: string,
  query: string,
) {
  const term = query.trim();
  return useQuery({
    queryKey: ["repository-search", `${owner}/${repo}`, term],
    queryFn: () => searchIssuesAndPulls(owner, repo, term),
    enabled: term.length > 0,
  });
}

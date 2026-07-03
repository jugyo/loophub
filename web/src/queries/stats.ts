import { useQuery } from "@tanstack/react-query";
import { getStats } from "@/api/client";

export const statsKeys = {
  all: ["stats"] as const,
};

/** Database statistics for the /stats page (#587). Fetched on page load; no live refresh. */
export function useStats() {
  return useQuery({
    queryKey: statsKeys.all,
    queryFn: getStats,
  });
}

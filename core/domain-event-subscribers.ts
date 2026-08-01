import type { DomainFactSubscriberMap } from "./domain-events.ts";
import {
  closeLinkedIssueAfterMerge,
  closeLinkedPulls,
} from "./service/linked-pulls.ts";

// Static wiring only. Subscriber procedures own all lookup, branching, writes and cascades.
export const subscribers = {
  "issue.closed": [closeLinkedPulls],
  "pull.closed": [closeLinkedIssueAfterMerge],
} satisfies DomainFactSubscriberMap;

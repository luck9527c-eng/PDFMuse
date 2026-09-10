import type { ConversationMessage } from "../shared/contracts";

/** 提取回答的可点击参考页码：选段页 + 全部证据页，去重后按页码升序。 */
export function getConversationReferencePages(message: ConversationMessage, selectedPassagePage?: number): number[] {
  const pages = new Set<number>();
  if (selectedPassagePage) pages.add(selectedPassagePage);
  for (const item of message.evidence ?? []) {
    if (typeof item.page === "number") pages.add(item.page);
  }
  return [...pages].sort((left, right) => left - right);
}

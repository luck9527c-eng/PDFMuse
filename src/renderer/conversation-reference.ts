import type { ConversationMessage } from "../shared/contracts";

export function getConversationReferencePage(message: ConversationMessage, selectedPassagePage?: number) {
  return selectedPassagePage ?? message.evidence?.[0]?.page;
}

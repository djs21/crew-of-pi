/**
 * Comms persistence — persists inter-agent messages to session entries.
 * Restores message bus state on session reload.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMessageBus } from "./comms.bus";
import type { CommsMessage } from "./comms.types";

/**
 * Save all current bus messages to session entries.
 */
export function persistBusState(pi: ExtensionAPI): void {
  const bus = getMessageBus();
  const messages = bus.getHistory();

  pi.appendEntry("crew-bus-state", {
    messageCount: messages.length,
    messages: messages.slice(-50), // Last 50 messages
    savedAt: Date.now(),
  });
}

/**
 * Restore bus state from session entries on startup.
 */
export function restoreBusState(pi: ExtensionAPI): void {
  // Bus state restoration happens via session_start event scanning
  // Messages are re-hydrated from "crew-bus-message" entries
}

/**
 * Persist a single message to session.
 */
export function persistMessage(pi: ExtensionAPI, message: CommsMessage): void {
  pi.appendEntry("crew-bus-message", {
    id: message.id,
    from: message.from,
    to: message.to,
    type: message.type,
    content: message.content,
    timestamp: message.timestamp,
    inReplyTo: message.inReplyTo,
  });
}

/**
 * Load persisted messages from session entries.
 */
export function loadPersistedMessages(entries: any[]): CommsMessage[] {
  const messages: CommsMessage[] = [];

  for (const entry of entries) {
    if (entry.customType === "crew-bus-message" && entry.data) {
      messages.push(entry.data as unknown as CommsMessage);
    }
  }

  return messages;
}
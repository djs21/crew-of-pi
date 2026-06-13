/**
 * Comms persistence — persists inter-agent messages to session entries.
 * Restores message bus state on session reload.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMessageBus } from "./comms.bus";
import type { CommsMessage } from "./comms.types";

/**
 * Restore bus state from session entries on startup.
 * Scans session entries for "crew-bus-message" custom entries and
 * injects them into the message bus without triggering subscribers.
 */
export function restoreBusState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const entries = ctx.sessionManager.getEntries();
  const messages = loadPersistedMessages(entries);

  if (messages.length === 0) return;

  const bus = getMessageBus();
  for (const msg of messages) {
    bus.injectHistory(msg);
  }
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
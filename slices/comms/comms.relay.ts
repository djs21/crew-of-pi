/**
 * Comms relay — relays inter-agent messages to the main agent as notifications.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMessageBus } from "./comms.bus";
import type { CommsMessage } from "./comms.types";
import { persistMessage } from "./comms.persistence";

/**
 * Register relay from message bus to main agent.
 * Routes subagent-to-subagent and subagent-to-main messages.
 */
export function registerCommsRelay(pi: ExtensionAPI): void {
  const bus = getMessageBus();

  // Subscribe to all messages
  bus.subscribe("all", (message: CommsMessage) => {
    // Only relay to main if it's not already to "main"
    if (message.to !== "main") {
      // Subagent-to-subagent conversation — notify main
      pi.sendMessage(
        {
          customType: "crew-comms-relay",
          content: `💬 **${message.from}** → **${message.to}**: ${message.content.slice(0, 200)}`,
          display: true,
          details: {
            from: message.from,
            to: message.to,
            type: message.type,
            content: message.content,
            timestamp: message.timestamp,
          },
        },
        { deliverAs: "steer", triggerTurn: false },
      );
    }
  });
}

/**
 * Send a response from main agent to a subagent.
 * Records the message in the bus and persists it.
 */
export function respondToSubagent(
  pi: ExtensionAPI,
  subagentId: string,
  message: string,
  inReplyTo?: string,
): CommsMessage {
  const bus = getMessageBus();
  const sent = bus.send("main", subagentId, "response", message, inReplyTo);

  // Persist to session
  persistMessage(pi, sent);

  return sent;
}

/**
 * Broadcast from main agent to all subagents.
 */
export function broadcastToAll(pi: ExtensionAPI, message: string): void {
  const bus = getMessageBus();
  const sent = bus.send("main", "broadcast", "broadcast", message);

  persistMessage(pi, sent);
}
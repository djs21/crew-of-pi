/**
 * Message bus — handles inter-agent communication.
 * All messages are logged and relayed to the main agent.
 */

import type { SubagentMessageType } from "../../shared/types";
import type { CommsMessage, CommsSubscription } from "./comms.types";
import { CHANNEL_BROADCAST } from "./comms.types";

/**
 * In-memory message bus for subagent communication.
 */
export class MessageBus {
  private messages: CommsMessage[] = [];
  private subscriptions: CommsSubscription[] = [];
  private nextId: number = 0;

  /**
   * Send a message on the bus.
   */
  send(from: string, to: string, type: SubagentMessageType, content: string, inReplyTo?: string): CommsMessage {
    const message: CommsMessage = {
      id: `msg-${this.nextId++}`,
      from,
      to,
      type,
      content,
      timestamp: Date.now(),
      inReplyTo,
    };

    this.messages.push(message);

    // Notify subscribers
    this.deliver(message);

    return message;
  }

  /**
   * Get all messages for a specific recipient.
   */
  getMessagesFor(recipientId: string): CommsMessage[] {
    return this.messages.filter(
      (m) => m.to === recipientId || m.to === CHANNEL_BROADCAST,
    );
  }

  /**
   * Get unread messages for a recipient since a timestamp.
   */
  getUnreadFor(recipientId: string, sinceTimestamp: number): CommsMessage[] {
    return this.messages.filter(
      (m) =>
        (m.to === recipientId || m.to === CHANNEL_BROADCAST) &&
        m.timestamp > sinceTimestamp,
    );
  }

  /**
   * Subscribe to messages on a channel.
   */
  subscribe(channel: string, handler: (message: CommsMessage) => void): () => void {
    const sub: CommsSubscription = { channel, handler };
    this.subscriptions.push(sub);
    return () => {
      const idx = this.subscriptions.indexOf(sub);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  /**
   * Get message history.
   */
  getHistory(): CommsMessage[] {
    return [...this.messages];
  }

  /**
   * Inject historical messages into the bus without notifying subscribers.
   * Used during session restore to re-hydrate persisted messages.
   */
  injectHistory(message: CommsMessage): void {
    this.messages.push(message);
    // Update nextId so future sends don't collide
    const num = parseInt(message.id.replace('msg-', ''), 10);
    if (!isNaN(num) && num >= this.nextId) this.nextId = num + 1;
  }

  /**
   * Clear all messages.
   */
  clear(): void {
    this.messages = [];
    this.subscriptions = [];
  }

  /**
   * Get message count.
   */
  get count(): number {
    return this.messages.length;
  }

  /**
   * Deliver a message to subscribers.
   */
  private deliver(message: CommsMessage): void {
    for (const sub of this.subscriptions) {
      if (
        sub.channel === message.to ||
        sub.channel === CHANNEL_BROADCAST ||
        sub.channel === "all"
      ) {
        try {
          sub.handler(message);
        } catch {
          // Isolate subscriber errors
        }
      }
    }
  }
}

// Singleton instance
let _instance: MessageBus | null = null;

export function getMessageBus(): MessageBus {
  if (!_instance) {
    _instance = new MessageBus();
  }
  return _instance;
}

export function resetMessageBus(): void {
  _instance = null;
}
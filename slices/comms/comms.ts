/**
 * Comms — inter-agent message bus, relay, and persistence.
 *
 * Consolidated from: comms.bus.ts, comms.relay.ts, comms.persistence.ts, comms.types.ts
 * Deleted (was pass-through): those 4 files.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentMessageType } from "../../shared/types";

// ─── Types (was comms.types.ts) ─────────────────────────────────

export interface CommsMessage {
  id: string;
  from: string;
  to: string;
  type: SubagentMessageType;
  content: string;
  timestamp: number;
  inReplyTo?: string;
}

interface CommsChannel {
  name: string;
  messages: CommsMessage[];
}

interface CommsSubscription {
  channel: string;
  handler: (message: CommsMessage) => void;
}

const CHANNEL_BROADCAST = "broadcast";
const CHANNEL_MAIN = "main";

// ─── MessageBus (was comms.bus.ts) ──────────────────────────────

export class MessageBus {
  private messages: CommsMessage[] = [];
  private subscriptions: CommsSubscription[] = [];
  private nextId: number = 0;

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
    this.deliver(message);
    return message;
  }

  getMessagesFor(recipientId: string): CommsMessage[] {
    return this.messages.filter(
      (m) => m.to === recipientId || m.to === CHANNEL_BROADCAST,
    );
  }

  getUnreadFor(recipientId: string, sinceTimestamp: number): CommsMessage[] {
    return this.messages.filter(
      (m) =>
        (m.to === recipientId || m.to === CHANNEL_BROADCAST) &&
        m.timestamp > sinceTimestamp,
    );
  }

  subscribe(channel: string, handler: (message: CommsMessage) => void): () => void {
    const sub: CommsSubscription = { channel, handler };
    this.subscriptions.push(sub);
    return () => {
      const idx = this.subscriptions.indexOf(sub);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  getHistory(): CommsMessage[] {
    return [...this.messages];
  }

  injectHistory(message: CommsMessage): void {
    this.messages.push(message);
    const num = parseInt(message.id.replace("msg-", ""), 10);
    if (!isNaN(num) && num >= this.nextId) this.nextId = num + 1;
  }

  clear(): void {
    this.messages = [];
    this.subscriptions = [];
  }

  get count(): number {
    return this.messages.length;
  }

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

// ─── Singleton (was comms.bus.ts) ───────────────────────────────

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

// ─── Persistence (was comms.persistence.ts) ─────────────────────

/**
 * Restore bus state from session entries on startup.
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

function loadPersistedMessages(entries: any[]): CommsMessage[] {
  const messages: CommsMessage[] = [];

  for (const entry of entries) {
    if (entry.customType === "crew-bus-message" && entry.data) {
      messages.push(entry.data as unknown as CommsMessage);
    }
  }

  return messages;
}

// ─── Relay (was comms.relay.ts) ─────────────────────────────────

/**
 * Register relay from message bus to main agent.
 */
export function registerCommsRelay(pi: ExtensionAPI): void {
  const bus = getMessageBus();

  bus.subscribe("all", (message: CommsMessage) => {
    if (message.to !== CHANNEL_MAIN) {
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
 */
export function respondToSubagent(
  pi: ExtensionAPI,
  subagentId: string,
  message: string,
  inReplyTo?: string,
): CommsMessage {
  const bus = getMessageBus();
  const sent = bus.send(CHANNEL_MAIN, subagentId, "response", message, inReplyTo);
  persistMessage(pi, sent);
  return sent;
}

/**
 * Broadcast from main agent to all subagents.
 */
export function broadcastToAll(pi: ExtensionAPI, message: string): void {
  const bus = getMessageBus();
  const sent = bus.send(CHANNEL_MAIN, "broadcast", "broadcast", message);
  persistMessage(pi, sent);
}

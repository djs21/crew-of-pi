/**
 * Comms types — inter-agent message bus definitions.
 */

import type { SubagentMessageType } from "../../shared/types";

export interface CommsMessage {
  id: string;
  from: string;
  to: string;
  type: SubagentMessageType;
  content: string;
  timestamp: number;
  inReplyTo?: string;
}

export interface CommsChannel {
  name: string;
  messages: CommsMessage[];
}

export interface CommsSubscription {
  channel: string;
  handler: (message: CommsMessage) => void;
}

export const CHANNEL_MAIN = "main";
export const CHANNEL_BROADCAST = "broadcast";
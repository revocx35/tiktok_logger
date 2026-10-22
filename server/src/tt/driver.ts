import type { DomAgent } from './dom.js';
import type { TtMessage, ThreadSnapshot } from './types.js';

/**
 * What the sender needs from the running service: a page that is logged in, a conversation that is open, and a way
 * to read the conversation back to confirm a message appeared. Implemented by service.ts; a separate type so the
 * sender can be unit-tested with a fake driver.
 */
export interface ChatDriver {
  /** Opens [chatId] in the tab (no-op when it is already open). */
  ensureChatOpen(chatId: string): Promise<void>;
  /** The IM protocol engine when it is active (sending and reading then never touch the page's DOM). */
  protocol(): import('./im/engine.js').ImEngine | null;
  /** The page agent; throws when TikTok is not connected or not logged in. */
  agent(): DomAgent;
  /** The open conversation as the page shows it. */
  snapshot(): Promise<ThreadSnapshot | null>;
  /** Maps a snapshot's rows to messages for [chatId] (timestamps filled in when the page shows none). */
  mapRows(chatId: string, snap: ThreadSnapshot): TtMessage[];
}

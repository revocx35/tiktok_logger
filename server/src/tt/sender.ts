import type { SendMediaKind, SendResult } from '../../../shared/api.js';
import type { AppContext, TtSender } from '../context.js';
import { AppError, Errors } from '../errors.js';
import type { ChatDriver } from './driver.js';
import { beginMediaFile, finishMediaFile } from './media.js';
import type { Ingest } from './ingest.js';
import type { TtMessage } from './types.js';

/**
 * Sending as the logged-in account, by driving the page the way a person does: the composer is filled, Enter (or the
 * send button) is pressed, and the conversation is re-read to confirm the message appeared. Nothing is signed or
 * replayed here — TikTok's own client does the work, which is why this keeps working when its signing changes.
 *
 * Not supported on purpose: unsend, edit and reactions. TikTok's web client has no stable UI for them (the menu
 * entries and confirmation dialogs are localized and change), so the API reports `not_supported` instead of
 * half-working automation.
 */
export class Sender implements TtSender {
  constructor(
    private readonly ctx: AppContext,
    private readonly ingest: Ingest,
    private readonly driver: ChatDriver,
  ) {}

  async sendText(chatId: string, text: string, _quotedId: string | null): Promise<SendResult> {
    const body = text.trim();
    if (!body) throw Errors.validation('The message is empty.');
    if (body.length > 2000) throw Errors.validation('TikTok messages are limited to 2000 characters.');
    await this.driver.ensureChatOpen(chatId);
    const agent = this.driver.agent();
    const typed = await agent.setText(body);
    if (!typed.ok) throw new AppError(502, 'composer', "TikTok's message box could not be filled. Open the conversation on the TikTok screen and try again.");
    const before = Date.now();
    const sent = await agent.send();
    if (!sent.ok) throw new AppError(502, 'send', 'TikTok did not accept the message. Check the TikTok screen.');
    const id = await this.confirm(chatId, (m) => m.fromMe && (m.text ?? '').trim() === body, before);
    this.ctx.repo.audit('message_sent', null, 'text');
    return { id };
  }

  async sendMedia(chatId: string, file: { data: Buffer; mime: string; filename: string | null }, kind: SendMediaKind, _quotedId: string | null): Promise<SendResult> {
    if (!/^(image|video|audio)\//.test(file.mime)) throw Errors.validation('Only photos, videos and audio files can be sent.');
    await this.driver.ensureChatOpen(chatId);
    const agent = this.driver.agent();
    const name = file.filename ?? (kind === 'voice' ? 'voice-message' : 'file');
    const attached = await agent.attachBase64(file.data, name, file.mime);
    if (!attached.ok) throw new AppError(502, 'attach', "TikTok's file input was not found. Open the conversation on the TikTok screen and try again.");
    // TikTok compresses/uploads in the page; give it a moment before pressing send.
    const before = Date.now();
    await sleep(1500);
    const sent = await agent.send();
    if (!sent.ok) throw new AppError(502, 'send', 'TikTok did not accept the file.');
    const id = await this.confirm(chatId, (m) => m.fromMe && (m.media?.length ?? 0) > 0, before);
    if (id) await this.storeOwnMedia(id, file).catch(() => undefined);
    this.ctx.repo.audit('message_sent', null, kind === 'voice' ? 'voice' : file.mime.split('/')[0]!);
    return { id };
  }

  /** Own uploads are stored from the bytes we already have: no download needed. */
  private async storeOwnMedia(messageId: string, file: { data: Buffer; mime: string; filename: string | null }): Promise<void> {
    const w = this.ctx.writer();
    if (!w) return;
    const row = this.ctx.repo.getMessage(messageId);
    if (!row || row.media_id) return;
    const pending = await beginMediaFile(this.ctx);
    await pending.writer.write(file.data);
    const { mediaId, size } = await finishMediaFile(this.ctx, pending, 'message', file.mime, file.filename);
    this.ctx.repo.updateMessage(messageId, { media_id: mediaId, media_status: 'downloaded', media_size: size, updated_at: Date.now() });
  }

  /**
   * Waits for the sent message to show up in the conversation, stores it, and returns our id. Sending is async in
   * TikTok's client, so this polls the page (not the network) for up to 15 s.
   */
  private async confirm(chatId: string, match: (m: TtMessage) => boolean, since: number): Promise<string | null> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const snap = await this.driver.snapshot().catch(() => null);
      if (!snap || snap.rows.length === 0) {
        await sleep(700);
        continue;
      }
      const found = this.driver.mapRows(chatId, snap).filter((m) => match(m) && m.ts >= since - 120_000);
      if (found.length) {
        // The last matching row is the one we just sent.
        const m = found[found.length - 1]!;
        const id = this.ingest.message({ ...m, source: 'sent' }, 'sent');
        if (id) return id;
      }
      await sleep(700);
    }
    return null;
  }

  async react(): Promise<void> {
    throw new AppError(400, 'not_supported', "tiktok_logger does not send reactions: TikTok's web client only offers them through a menu that changes constantly.");
  }

  async unsend(): Promise<void> {
    throw new AppError(400, 'not_supported', 'tiktok_logger does not unsend messages. Delete it in the TikTok app or on the TikTok screen.');
  }

  async edit(): Promise<void> {
    throw new AppError(400, 'not_supported', 'TikTok does not let anyone edit a sent message.');
  }

  /** Opening the conversation is what marks it seen on TikTok. */
  async markRead(chatId: string): Promise<void> {
    if (!this.ctx.settings.get().readReceipts) return;
    await this.driver.ensureChatOpen(chatId);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

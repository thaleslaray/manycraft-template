import { z } from 'zod'
const user = z.object({ id: z.number().int().positive(), is_bot: z.boolean().optional(),
  first_name: z.string().max(256).optional(), last_name: z.string().max(256).optional(), username: z.string().max(256).optional() })
const chat = z.object({ id: z.number().int(), type: z.string() })
/** Fields of Message (tipos/Message.md) that say what the user sent besides text. Their inner shape is not needed to name the kind. */
export const telegramContentKeys = ['photo', 'video', 'animation', 'document', 'audio', 'voice', 'video_note', 'sticker'] as const
export const telegramLocation = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
export const telegramContact = z.object({ phone_number: z.string().min(1).max(64), first_name: z.string().max(256), last_name: z.string().max(256).optional() })
export const telegramUpdate = z.object({
  update_id: z.number().int().nonnegative(),
  // A text longer than 4096 never comes from Telegram; parseInbound cuts it instead of discarding the whole update.
  message: z.object({ message_id: z.number().int(), date: z.number().int().nonnegative().optional(), from: user, chat, text: z.string().optional(), caption: z.string().optional(),
    photo: z.unknown().optional(), video: z.unknown().optional(), animation: z.unknown().optional(), document: z.unknown().optional(), audio: z.unknown().optional(),
    voice: z.unknown().optional(), video_note: z.unknown().optional(), sticker: z.unknown().optional(), location: z.unknown().optional(), contact: z.unknown().optional() }).optional(),
  callback_query: z.object({ id: z.string().min(1).max(256), from: user, data: z.string().max(64).refine(value => new TextEncoder().encode(value).length <= 64).optional(),
    message: z.object({ chat }).optional() }).optional(),
  /** tipos/ChatMemberUpdated.md: in a private chat it arrives only when the user blocks or unblocks the bot (tipos/Update.md). */
  my_chat_member: z.object({ chat, from: user, new_chat_member: z.object({ status: z.string().max(32) }) }).optional(),
})

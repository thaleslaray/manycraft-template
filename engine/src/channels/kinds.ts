/** Every channel kind the product knows. Lists of channels elsewhere derive from this one. Kept free of imports so schemas the panel shares can use it. */
export const channelKinds = ['telegram', 'instagram', 'messenger', 'whatsapp', 'tiktok', 'email'] as const
export type ChannelType = typeof channelKinds[number]

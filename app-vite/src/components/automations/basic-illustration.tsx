import { cn } from "@/lib/utils"

type Pill = { text: string; tone?: "accent" | "plain"; align?: "start" | "end" }

/** Mensagens de exemplo de cada item básico: ilustração própria (balões da marca), sem imagem externa. */
const scenes: Record<string, Pill[]> = {
  conversation_starters: [{ text: "Como funciona?", tone: "accent" }, { text: "Quais são os preços?", tone: "plain" }, { text: "Quero falar com alguém", tone: "plain" }],
  default_reply: [{ text: "Tenho uma pergunta", tone: "accent", align: "end" }, { text: "Fale com uma pessoa", tone: "plain" }, { text: "Veja as perguntas frequentes", tone: "plain" }],
  main_menu: [{ text: "Mais opções", tone: "accent" }, { text: "Cursos", tone: "plain" }, { text: "Entregas", tone: "plain" }, { text: "Suporte", tone: "plain" }],
  welcome_message: [{ text: "Oi", tone: "accent", align: "end" }, { text: "Olá! Que bom ter você aqui.", tone: "plain" }],
  system_opt_in: [{ text: "voltar", tone: "accent", align: "end" }, { text: "Você voltou a receber nossas mensagens.", tone: "plain" }],
  system_opt_out: [{ text: "parar", tone: "accent", align: "end" }, { text: "Tudo certo, você não receberá mais mensagens.", tone: "plain" }],
}

export function BasicIllustration({ kind }: { kind: string }) {
  const pills = scenes[kind] ?? scenes.default_reply
  return <div aria-hidden="true" style={{ backgroundImage: "repeating-linear-gradient(0deg, color-mix(in srgb, var(--color-surface) 75%, transparent) 0 1px, transparent 1px 28px), repeating-linear-gradient(90deg, color-mix(in srgb, var(--color-surface) 75%, transparent) 0 1px, transparent 1px 28px)" }} className="hidden h-40 w-[16.9rem] shrink-0 flex-col justify-center gap-2 overflow-hidden rounded-lg bg-accent-soft px-4 sm:flex">
    {pills.map(pill => <span key={pill.text} className={cn("max-w-full truncate rounded-pill px-3 py-1.5 text-2xs shadow-card", pill.align === "end" ? "self-end" : "self-start", pill.tone === "accent" ? "bg-accent text-on-accent" : "bg-surface text-text")}>{pill.text}</span>)}
  </div>
}

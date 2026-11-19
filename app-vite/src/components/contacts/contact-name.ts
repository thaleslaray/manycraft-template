import type { Contact } from "@/data"

export const contactName = (c: Pick<Contact, "first_name" | "last_name"> & Partial<Pick<Contact, "status">>) =>
  c.status === "deleted" ? "Contato sem identificação" : `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Sem nome"

export const statusLabel: Record<Contact["status"], string> = {
  subscribed: "Inscrito",
  unsubscribed: "Cancelado",
  deleted: "Excluído",
}

import { automations } from "./seed"

/** Ids do seed, para generateStaticParams. O backend real troca isto por consulta. */
export const automationIds = automations.map((a) => a.id)

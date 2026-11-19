import * as React from "react"
import { roleCan, type Action, type Role } from "../../../shared/permissions"

/** Papel de quem está no painel, vindo da sessão. Fora do espaço (testes, galeria) conta como dono. */
export const RoleContext = React.createContext<Role>("owner")

export function useRole(): Role {
  return React.useContext(RoleContext)
}

/** Esconde o que o motor recusaria. A recusa de verdade continua no motor. */
export function useCan(action: Action): boolean {
  return roleCan(useRole(), action)
}

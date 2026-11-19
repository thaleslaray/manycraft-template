import { emailProblem, phoneProblem } from "../../../../shared/phone"
import { useState } from 'react'
import { createContact } from '@/data/contact-imports'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'

export function CreateContactDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  return <Dialog open onOpenChange={open => !open && !busy && onClose()}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>Criar contato</DialogTitle><DialogDescription>Adicione os dados da pessoa à sua lista de contatos.</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={async event => {
        event.preventDefault()
        const values = new FormData(event.currentTarget)
        // Mesma regra do motor, para o erro aparecer antes de enviar.
        const problem = phoneProblem(String(values.get('phone')).replace(/\D/g, '')) ?? emailProblem(String(values.get('email')).trim())
        if (problem) { setError(problem); return }
        setBusy(true); setError('')
        try {
          const contact = await createContact({ first_name: String(values.get('first_name')), last_name: String(values.get('last_name')), phone: String(values.get('phone')), email: String(values.get('email')) })
          onCreated(contact.id)
        } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível criar o contato.'); setBusy(false) }
      }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="create-first">Primeiro nome</Label><Input id="create-first" name="first_name" autoComplete="given-name" maxLength={60} /></div>
          <div className="space-y-1"><Label htmlFor="create-last">Sobrenome</Label><Input id="create-last" name="last_name" autoComplete="family-name" maxLength={60} /></div>
        </div>
        <div className="space-y-1"><Label htmlFor="create-phone">Telefone</Label><Input id="create-phone" name="phone" type="tel" autoComplete="tel" placeholder="+55 (11) 99999-9999" required pattern="\+?[0-9\(\).\s\-]+" /><p className="text-xs text-text-muted">Inclua o código do país e o DDD. Salvamos apenas os dígitos.</p></div>
        <div className="space-y-1"><Label htmlFor="create-email">E-mail</Label><Input id="create-email" name="email" type="email" autoComplete="email" maxLength={254} required /></div>
        <p className="text-xs text-text-muted">Cadastrar os dados não autoriza envios pelas conexões.</p>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <DialogFooter><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancelar</Button><Button type="submit" loading={busy}>Salvar contato</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

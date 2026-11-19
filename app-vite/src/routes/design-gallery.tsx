import * as React from "react"
import { toast } from "sonner"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/ui/status-badge"
import { Input, Textarea } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/ui/empty-state"
import { Banner } from "@/components/ui/banner"
import { TagChip } from "@/components/ui/tag-chip"
import { KeywordChips } from "@/components/ui/keyword-chips"
import { MetricCard } from "@/components/ui/metric-card"
import { NumberedStep } from "@/components/ui/numbered-step"
import { DataTable, type Column } from "@/components/ui/data-table"
import { ChooseExisting } from "@/components/ui/choose-existing"
import { RowMenu, RowMenuItem } from "@/components/ui/row-menu"
import { PanelFooterBar } from "@/components/ui/panel-footer-bar"
import { SidePanel } from "@/components/ui/side-panel"

const automacoes = [
  { id: "a1", label: "Boas-vindas", hint: "Quando alguém envia a primeira mensagem", resumo: "Envia uma saudação e pergunta o que a pessoa procura." },
  { id: "a2", label: "Carrinho abandonado", hint: "Quando alguém deixa o carrinho", resumo: "Espera 1 hora e lembra do carrinho com um cupom." },
  { id: "a3", label: "Promoção de Páscoa", hint: "Palavra-chave PASCOA", resumo: "Conta a promoção e oferece o link da loja." },
]

type Row = { id: string; nome: string; status: string; entrou: string }

const allRows: Row[] = Array.from({ length: 6 }, (_, i) => ({
  id: `c${i + 1}`,
  nome: ["Ana Exemplo", "Bruno Teste", "Carla Demo", "Davi Modelo", "Elisa Prova", "Fábio Amostra"][i],
  status: i % 2 ? "Inscrito" : "Inscrita",
  entrou: ["há 12 min", "há 1 h", "há 3 h", "ontem", "há 2 dias", "há 5 dias"][i],
}))

const columns: Column<Row>[] = [
  { key: "nome", header: "Nome", cell: (r) => r.nome },
  { key: "status", header: "Status", cell: (r) => r.status },
  { key: "entrou", header: "Entrou", cell: (r) => <span className="text-text-muted">{r.entrou}</span> },
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`s-${title}`} className="space-y-3">
      <h2 id={`s-${title}`} className="text-lg font-semibold">{title}</h2>
      <div className="space-y-4 rounded-lg border border-border bg-surface p-5">{children}</div>
    </section>
  )
}

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-text-muted">{children}</label>
}

export function DesignGallery() {
  const [incl, setIncl] = React.useState(["quero", "eu quero"])
  const [excl, setExcl] = React.useState(["cancelar"])
  const [full, setFull] = React.useState(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"])
  const [sel, setSel] = React.useState<Set<string>>(new Set(["c1"]))
  const [shown, setShown] = React.useState(3)
  const [moreLoading, setMoreLoading] = React.useState(false)
  const [on, setOn] = React.useState(true)
  const [escolhaAberta, setEscolhaAberta] = React.useState(false)
  const [escolhida, setEscolhida] = React.useState("Nenhuma")
  const [painelAtivo, setPainelAtivo] = React.useState(true)
  const [acao, setAcao] = React.useState("Nenhuma")

  function loadMore() {
    setMoreLoading(true)
    setTimeout(() => {
      setShown((n) => Math.min(n + 3, allRows.length))
      setMoreLoading(false)
    }, 600)
  }

  return (
    <main className="mx-auto max-w-(--content-max) space-y-8 p-6">
      <h1 className="text-xl font-bold">Primitivos</h1>

      <Section title="Botão">
        {(["primary", "secondary", "ghost", "danger", "link"] as const).map((v) => (
          <div key={v} className="flex flex-wrap items-center gap-3">
            <span className="w-20 text-xs text-text-muted">{v}</span>
            <Button variant={v} size="sm">Pequeno</Button>
            <Button variant={v}>Médio</Button>
            <Button variant={v} size="lg">Grande</Button>
            <Button variant={v} disabled>Desativado</Button>
            <Button variant={v} loading>Salvando</Button>
          </div>
        ))}
        <div className="flex items-center gap-3">
          <span className="w-20 text-xs text-text-muted">ícone</span>
          <Button size="icon" variant="secondary" aria-label="Adicionar"><Plus className="size-4" aria-hidden="true" /></Button>
        </div>
      </Section>

      <Section title="Status">
        <div className="flex flex-wrap gap-3">
          <StatusBadge status="live" />
          <StatusBadge status="stopped" />
          <StatusBadge status="draft" />
          <StatusBadge status="error" />
        </div>
      </Section>

      <Section title="Campos">
        <div className="grid gap-4 md:grid-cols-2">
          <div><Label htmlFor="f1">Normal</Label><Input id="f1" placeholder="Digite aqui" /></div>
          <div><Label htmlFor="f2">Desativado</Label><Input id="f2" disabled defaultValue="Não editável" /></div>
          <div><Label htmlFor="f3">Somente leitura</Label><Input id="f3" readOnly defaultValue="Só leitura" /></div>
          <div>
            <Label htmlFor="f4">Com erro</Label>
            <Input id="f4" aria-invalid="true" aria-describedby="f4-erro" defaultValue="abc" />
            <p id="f4-erro" className="mt-1 text-xs text-danger">Use ao menos 5 caracteres.</p>
          </div>
          <div className="md:col-span-2"><Label htmlFor="f5">Texto longo</Label><Textarea id="f5" placeholder="Escreva a mensagem" /></div>
          <div>
            <Label htmlFor="f6">Seleção</Label>
            <Select defaultValue="all">
              <SelectTrigger id="f6"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Qualquer post ou Reel</SelectItem>
                <SelectItem value="one">Um post específico</SelectItem>
                <SelectItem value="next">Próximo post</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="f7">Seleção desativada</Label>
            <Select disabled>
              <SelectTrigger id="f7"><SelectValue placeholder="Escolha" /></SelectTrigger>
              <SelectContent><SelectItem value="x">x</SelectItem></SelectContent>
            </Select>
          </div>
        </div>
      </Section>

      <Section title="Interruptor">
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2"><Switch checked={on} onCheckedChange={setOn} aria-label="Gatilho ativo" />Ativo: {on ? "sim" : "não"}</label>
          <label className="flex items-center gap-2"><Switch disabled aria-label="Desativado" />Desativado</label>
        </div>
      </Section>

      <Section title="Abas">
        <Tabs defaultValue="a">
          <TabsList><TabsTrigger value="a">Agendado</TabsTrigger><TabsTrigger value="b">Rascunhos</TabsTrigger><TabsTrigger value="c">Histórico</TabsTrigger></TabsList>
          <TabsContent value="a">Conteúdo da aba agendado.</TabsContent>
          <TabsContent value="b">Conteúdo da aba rascunhos.</TabsContent>
          <TabsContent value="c">Conteúdo da aba histórico.</TabsContent>
        </Tabs>
        <Tabs defaultValue="todos">
          <TabsList variant="segmented"><TabsTrigger value="todos">Todos os canais</TabsTrigger><TabsTrigger value="wa">WhatsApp</TabsTrigger></TabsList>
          <TabsContent value="todos">Visão de todos os canais.</TabsContent>
          <TabsContent value="wa">Visão do WhatsApp.</TabsContent>
        </Tabs>
      </Section>

      <Section title="Diálogo e aviso">
        <div className="flex flex-wrap gap-3">
          <Dialog>
            <DialogTrigger asChild><Button variant="secondary">Abrir diálogo</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Excluir automação?</DialogTitle>
                <DialogDescription>Ela vai para a lixeira e para de responder.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild><Button variant="secondary">Cancelar</Button></DialogClose>
                <DialogClose asChild><Button variant="danger">Excluir</Button></DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Button variant="secondary" onClick={() => toast.success("Alterações salvas.")}>Toast de sucesso</Button>
          <Button variant="secondary" onClick={() => toast.error("Não deu para salvar.")}>Toast de erro</Button>
          <Button variant="secondary" onClick={() => toast("Automação movida.", { action: { label: "Desfazer", onClick: () => {} } })}>Toast com ação</Button>
        </div>
      </Section>

      <Section title="Banner">
        <Banner variant="info">Seus contatos novos aparecem aqui em segundos.</Banner>
        <Banner variant="warning">Você está vendo a versão publicada · <a href="#" className="font-semibold underline">Editar</a></Banner>
        <Banner variant="danger">O canal do Instagram foi desconectado.</Banner>
      </Section>

      <Section title="Carregando e vazio">
        <div className="flex gap-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-10 w-32" /><Skeleton className="size-10 rounded-pill" /></div>
        <EmptyState title="Nenhuma automação ainda" description="Crie a primeira e ela aparece aqui." action={<Button>Criar automação</Button>} />
      </Section>

      <Section title="Tags">
        <div className="flex flex-wrap gap-2">
          <TagChip label="lead-quero" />
          <TagChip variant="removable" label="cliente" onRemove={() => toast("Tag removida.")} />
          <TagChip variant="add" label="Adicionar tag" onAdd={() => toast("Abrir seletor de tags.")} />
        </div>
      </Section>

      <Section title="Palavras-chave">
        <p className="text-text-muted">tem uma destas palavras (Enter ou vírgula cria; cole “a, b” para criar duas)</p>
        <KeywordChips label="Palavras incluídas" value={incl} onChange={setIncl} />
        <p className="text-text-muted">e não tem</p>
        <KeywordChips label="Palavras excluídas" variant="exclude" value={excl} onChange={setExcl} />
        <p className="text-text-muted">no limite de 10</p>
        <KeywordChips label="Palavras no limite" value={full} onChange={setFull} />
      </Section>

      <Section title="Métricas e passos">
        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label="Contatos" value={1240} />
          <MetricCard label="Novos hoje" value={18} delta="+3 ontem" />
          <MetricCard label="Execuções" loading />
          <MetricCard label="Tempo economizado" emptyText="Sem dados ainda" action={<Button variant="link" size="sm">Ver como funciona</Button>} />
        </div>
        <NumberedStep n={1} title="Quando alguém comenta"><p className="text-text-muted">Escolha a publicação.</p></NumberedStep>
        <NumberedStep n={2} title="E o comentário"><p className="text-text-muted">Defina as palavras.</p></NumberedStep>
      </Section>

      <Section title="Tabela">
        <DataTable
          caption="Contatos de exemplo"
          columns={columns}
          rows={allRows.slice(0, shown)}
          getId={(r) => r.id}
          selectable
          selected={sel}
          onSelectedChange={setSel}
          total={allRows.length}
          hasMore={shown < allRows.length}
          loadingMore={moreLoading}
          onLoadMore={loadMore}
        />
        <p className="text-xs text-text-muted">Carregando</p>
        <DataTable caption="Carregando" columns={columns} rows={[]} getId={(r) => r.id} loading />
        <p className="text-xs text-text-muted">Vazia</p>
        <DataTable caption="Vazia" columns={columns} rows={[]} getId={(r) => r.id} empty={<EmptyState title="Nenhum contato" description="Quem interagir aparece aqui." />} />
      </Section>

      <Section title="Escolher existente">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => setEscolhaAberta(true)}>Escolher automação</Button>
          <span>Escolhida: <strong>{escolhida}</strong></span>
        </div>
        <ChooseExisting
          open={escolhaAberta}
          onOpenChange={setEscolhaAberta}
          title="Escolher automação existente"
          items={automacoes}
          searchLabel="Buscar automação"
          onChoose={(item) => setEscolhida(item.label)}
          renderPreview={(item) => (
            <div className="space-y-2">
              <h3 className="font-semibold">{item.label}</h3>
              <p className="text-text-muted">{item.resumo}</p>
            </div>
          )}
        />
      </Section>

      <Section title="Barra inferior do painel">
        <div className="h-96 max-w-md">
          <SidePanel
            title="Palavra-chave"
            tone="trigger"
            onClose={() => toast("Painel fechado.")}
            footer={
              <PanelFooterBar switchLabel="Ativa" checked={painelAtivo} onCheckedChange={setPainelAtivo}>
                <Button variant="secondary" size="sm" onClick={() => setAcao("Cancelar")}>Cancelar</Button>
                <Button size="sm" onClick={() => setAcao("Salvar")}>Salvar</Button>
              </PanelFooterBar>
            }
          >
            {Array.from({ length: 12 }, (_, i) => <p key={i} className="text-text-muted">Linha {i + 1} do corpo que rola acima da barra.</p>)}
          </SidePanel>
        </div>
        <p>Última ação: <strong>{acao}</strong></p>
      </Section>

      <Section title="Menu de linha">
        <ul className="divide-y divide-border rounded-md border border-border">
          {["Boas-vindas", "Carrinho abandonado"].map((nome) => (
            <li key={nome} className="flex items-center justify-between px-4 py-2">
              <span>{nome}</span>
              <RowMenu item={nome}>
                <RowMenuItem onSelect={() => toast(`Duplicar ${nome}`)}>Duplicar</RowMenuItem>
                <RowMenuItem onSelect={() => toast(`Excluir ${nome}`)}>Excluir</RowMenuItem>
              </RowMenu>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Faixa de abas rolável">
        <Tabs defaultValue="t1">
          <TabsList scrollable aria-label="Seções de automação">
            {["Minhas automações", "Básico", "Sequências", "Palavras-chave", "Regras", "Transmissões", "Modelos"].map((nome, i) => (
              <TabsTrigger key={nome} value={`t${i + 1}`}>{nome}</TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="t1">Conteúdo de minhas automações.</TabsContent>
        </Tabs>
      </Section>
    </main>
  )
}

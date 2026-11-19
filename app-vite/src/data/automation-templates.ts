import { apiRequest } from './api'
import type { Automation, Graph } from './types'

export type AutomationTemplate = {
  id: string; version: number; name: string; description: string; category: string
  icon: 'welcome' | 'link' | 'clock' | 'map' | 'calendar' | 'help'
  trigger: { kind: 'keyword' | 'welcome_message'; word?: string; label: string }
  link?: { label: string; url: string }; graph: Graph; warnings: string[]
}
export async function listAutomationTemplates(connection?: string): Promise<{ templates: AutomationTemplate[] }> {
  return apiRequest(`/automation-templates${connection ? `?connection_id=${encodeURIComponent(connection)}` : ''}`)
}
export async function createFromTemplate(input: { template_id: string; version: number; connection_id: string; folder_id: string | null; word?: string; url?: string }): Promise<Automation> {
  return apiRequest('/automation-templates', { method: 'POST', body: JSON.stringify(input) })
}

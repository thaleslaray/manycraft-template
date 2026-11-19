import * as triggerMetrics from './trigger-metrics'
export * from "./automations"
export * from "./automation-triggers"
export * from "./automation-stats"
export * from "./contacts"
export * from "./tags"
export * from "./fields"
export * from "./keywords"
export * from "./trigger-firings"
export { RepositoryError } from "./shared"

import * as automations from "./automations"
import * as automationTriggers from "./automation-triggers"
import * as automationStats from "./automation-stats"
import * as contacts from "./contacts"
import * as tags from "./tags"
import * as fields from "./fields"
import * as keywords from "./keywords"
import * as sequences from "./sequences"
import * as calledByModule from './called-by'
import * as firings from "./trigger-firings"
import { authorize, type Principal } from "../permissions"
import { RepositoryError, assertWorkspace } from "./shared"

/** The only binding accessor; HTTP handlers receive a scoped repository. */
export function repositoryFor(env: { DB: D1Database }, workspaceId: string, principal: Principal) {
  assertWorkspace(workspaceId)
  const db = env.DB
  const repository = {
    listAutomations: (opts?: Parameters<typeof automations.listAutomations>[2]) => automations.listAutomations(db, workspaceId, opts),
    getAutomation: (id: string) => automations.getAutomation(db, workspaceId, id),
    getAutomationTriggerMetrics: (id: string, filter: triggerMetrics.MetricFilter) => triggerMetrics.getAutomationTriggerMetrics(db, workspaceId, id, filter),
    getAutomationMetricContacts: (id: string, filter: triggerMetrics.MetricFilter & { metric: triggerMetrics.Metric; cursor?: string }) => triggerMetrics.getAutomationMetricContacts(db, workspaceId, id, filter),
    getAutomationCalledBy: (id: string) => calledByModule.calledBy(db, workspaceId, id),
    getAutomationStats: (id: string, periodDays: number) => automationStats.getAutomationStats(db, workspaceId, id, periodDays),
    listAutomationTriggers: (id: string) => automationTriggers.listAutomationTriggers(db, workspaceId, id),
    createAutomationTrigger: (id: string, input: automationTriggers.TriggerCreate) => automationTriggers.createAutomationTrigger(db, workspaceId, id, input),
    updateAutomationTrigger: (id: string, triggerId: string, input: automationTriggers.TriggerPatch) => automationTriggers.updateAutomationTrigger(db, workspaceId, id, triggerId, input),
    saveDraft: (id: string, graph: unknown) => automations.saveDraft(db, workspaceId, id, graph),
    publishAutomation: (id: string) => automations.publishAutomation(db, workspaceId, id),
    listContacts: (cursor: string | null = null, filter?: Parameters<typeof contacts.listContacts>[3], pageSize?: number) => contacts.listContacts(db, workspaceId, cursor, filter, pageSize),
    searchContacts: (search: string, cursor: string | null = null) => contacts.searchContacts(db, workspaceId, search, cursor),
    getContact: (id: string) => contacts.getContact(db, workspaceId, id),
    listTags: () => tags.listTags(db, workspaceId),
    getTag: (id: string) => tags.getTag(db, workspaceId, id),
    createTag: (name: string) => tags.createTag(db, workspaceId, name),
    deleteTag: (id: string) => tags.deleteTag(db, workspaceId, id),
    tagContacts: (ids: string[], tagId: string, op: "add" | "remove" = "add") => tags.tagContacts(db, workspaceId, ids, tagId, op),
    listFields: () => fields.listFields(db, workspaceId),
    getField: (id: string) => fields.getField(db, workspaceId, id),
    createField: (input: fields.FieldInput) => fields.createField(db, workspaceId, input),
    setFieldValue: (contactId: string, fieldId: string, value: unknown) => fields.setFieldValue(db, workspaceId, contactId, fieldId, value),
    listKeywords: () => keywords.listKeywords(db, workspaceId),
    getKeyword: (id: string) => keywords.getKeyword(db, workspaceId, id),
    saveKeyword: (input: keywords.KeywordInput) => keywords.saveKeyword(db, workspaceId, input),
    deleteKeyword: (id: string) => keywords.deleteKeyword(db, workspaceId, id),
    listKeywordRules: () => keywords.listKeywordRules(db, workspaceId),
    getKeywordRule: (id: string) => keywords.getKeywordRule(db, workspaceId, id),
    saveKeywordRule: (input: keywords.KeywordRuleInput, id?: string) => keywords.saveKeywordRule(db, workspaceId, input, id),
    createKeywordAutomation: (input: keywords.KeywordAutomationInput) => keywords.createKeywordAutomation(db, workspaceId, input),
    setKeywordRuleActive: (id: string, active: boolean) => keywords.setKeywordRuleActive(db, workspaceId, id, active),
    moveKeywordRule: (id: string, target: number) => keywords.moveKeywordRule(db, workspaceId, id, target),
    deleteKeywordRule: (id: string) => keywords.deleteKeywordRule(db, workspaceId, id),
    listSequences: () => sequences.listSequences(db, workspaceId),
    getSequence: (id: string) => sequences.getSequence(db, workspaceId, id),
    listSequenceFlows: () => sequences.listSequenceFlows(db, workspaceId),
    saveSequence: (input: sequences.SequenceInput, id?: string) => sequences.saveSequence(db, workspaceId, input, id),
    deleteSequence: (id: string) => sequences.deleteSequence(db, workspaceId, id),
    recordTriggerFiring: (input: firings.TriggerFiringInput) => firings.recordTriggerFiring(db, workspaceId, input),
  }
  // Every HTTP repository invocation checks role and workspace before reaching SQL.
  return new Proxy(repository, {
    get(target, property: keyof typeof repository) {
      const method = target[property]
      if (typeof method !== 'function') return method
      return (...args: unknown[]) => {
        if (principal.workspaceId !== workspaceId) throw new RepositoryError('Workspace inválido.', 403)
        const read = /^(list|get|search)/.test(property)
        authorize(principal, read ? /Automation|Keyword|Sequence/.test(property) ? 'automation:read' : 'read' : 'edit')
        return (method as (...input: unknown[]) => unknown)(...args)
      }
    },
  })
}

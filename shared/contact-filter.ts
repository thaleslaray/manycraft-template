export type FilterOperator = 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'starts_with' | 'is_set' | 'is_not_set' | 'gt' | 'gte' | 'lt' | 'lte' | 'within_last_days'
export type ContactFilterRule =
  | { type: 'tag'; tag_id: string; operator: 'has' | 'not_has' }
  | { type: 'field'; field_id: string; operator: FilterOperator; value?: unknown; case_sensitive?: boolean }
  | { type: 'system'; field: 'first_name' | 'last_name' | 'status' | 'gender' | 'subscribed_at' | 'last_interaction_at' | 'phone' | 'locale' | 'timezone' | 'last_input_text' | 'contact_id'; operator: FilterOperator; value?: unknown; case_sensitive?: boolean }
  | { type: 'connection'; connection_id: string; operator: 'in_connection' | 'not_in_connection' }
  | { type: 'window24'; connection_id: string; operator: 'inside' | 'outside' | 'follow_up_eligible' | 'outside_24_plus_1' }
  /** Inscrito no canal: contato inscrito e com recebimento autorizado em alguma conexão daquele canal. */
  | { type: 'channel'; channel: string; operator: 'subscribed' | 'not_subscribed' }
  /** Gatilho de entrada: o primeiro gatilho que trouxe o contato (optin_source = trigger:<id>). */
  | { type: 'entry_trigger'; trigger_id: string; operator: 'entered_by' | 'not_entered_by' }
export type ContactQueryFilter = { match: 'all' | 'any'; rules: ContactFilterRule[] }

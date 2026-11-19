import { QuestionPanel } from "./question-panel"
import { MessagePanel } from "./message-panel"
import { ActionPanel, DelayPanel, DynamicPanel, TemplateMessagePanel } from "./node-panels"
import { ConditionPanel, RandomizerPanel, StartAutomationPanel } from "./logic-panels"
import { TriggerPanel } from "./trigger-panel"
import type { PanelProps } from "./panel-shared"

export type { PanelProps }

export function PanelHost(props: PanelProps) {
  switch (props.node.type) {
    case "trigger":
      return <TriggerPanel {...props} />
    case "question": return <QuestionPanel {...props} />
    case "message":
      return <MessagePanel {...props} />
    case "action":
      return <ActionPanel {...props} />
    case "condition": return <ConditionPanel {...props} />
    case "randomizer":
    case "split": return <RandomizerPanel {...props} />
    case "start_automation":
    case "goto": return <StartAutomationPanel {...props} />
    case "smart_delay": return <DelayPanel {...props} />
    case "dynamic": return <DynamicPanel {...props} />
    case "template_message": return <TemplateMessagePanel {...props} />
    default: return <p role="alert">Este tipo de passo ainda não tem edição disponível.</p>
  }
}

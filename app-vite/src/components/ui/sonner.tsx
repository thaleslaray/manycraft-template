import { Toaster as Sonner, type ToasterProps } from "sonner"

function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="light"
      className="toaster"
      containerAriaLabel="Notificações"
      toastOptions={{
        classNames: {
          toast:
            "!rounded-md !border !border-border !bg-surface !text-text !shadow-pop !font-sans !text-sm",
          description: "!text-text-muted",
          actionButton: "!bg-accent !text-on-accent !rounded-sm",
          error: "!text-danger",
          success: "!text-success",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }

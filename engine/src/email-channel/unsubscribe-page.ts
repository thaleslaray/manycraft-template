/** Public confirmation keeps no account identifiers, addresses or tracking tokens in its markup. */
export const unsubscribeConfirmation = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Descadastro confirmado</title>
<style>
:root { --page: oklch(0.98 0.003 260); --surface: oklch(1 0 0); --text: oklch(0.23 0.015 260); --muted: oklch(0.50 0.015 260); --line: oklch(0.90 0.008 260); --success-surface: oklch(0.96 0.025 160); --success-text: oklch(0.40 0.08 160); }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100svh; display: grid; place-items: center; padding: 24px 16px; background: var(--page); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
main { width: min(100%, 520px); padding: 40px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); }
.status { display: inline-block; margin: 0 0 24px; padding: 6px 10px; border-radius: 6px; background: var(--success-surface); color: var(--success-text); font-size: 12px; font-weight: 600; }
h1 { margin: 0 0 16px; font-size: clamp(26px, 5vw, 32px); line-height: 1.18; letter-spacing: -0.025em; font-weight: 650; }
p { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.65; }
footer { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; line-height: 1.5; }
@media (max-width: 480px) { main { padding: 28px 24px; } }
@media (prefers-color-scheme: dark) { :root { --page: oklch(0.16 0.008 260); --surface: oklch(0.21 0.008 260); --text: oklch(0.94 0.005 260); --muted: oklch(0.73 0.012 260); --line: oklch(0.32 0.012 260); --success-surface: oklch(0.28 0.035 160); --success-text: oklch(0.82 0.07 160); } }
</style>
</head>
<body><main aria-labelledby="confirmation-title"><span class="status">Preferência atualizada</span><h1 id="confirmation-title">Descadastro confirmado</h1><p>Você deixou de receber mensagens de marketing por e-mail. As respostas às suas conversas continuam disponíveis.</p><footer>Você pode fechar esta página.</footer></main></body>
</html>`

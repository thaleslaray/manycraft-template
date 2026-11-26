import test from "node:test"
import assert from "node:assert/strict"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { AuthError, authErrorMessage, authRequest, limparCodigo, precisaDeCodigoNovo } = await import("./auth.ts")

test("limparCodigo tira espaços, traços e o que não é dígito, e corta em 6", () => {
  assert.equal(limparCodigo("123456"), "123456")
  assert.equal(limparCodigo(" 123 456 "), "123456")
  assert.equal(limparCodigo("123-456"), "123456")
  assert.equal(limparCodigo("1 2-3\t4\n5 6"), "123456")
  assert.equal(limparCodigo("12345678"), "123456")
  assert.equal(limparCodigo("Seu código: 987-654."), "987654")
  assert.equal(limparCodigo("12 3"), "123")
  assert.equal(limparCodigo("abc"), "")
  assert.equal(limparCodigo(""), "")
})

test("erros do pedido de código mostram a mensagem em português que o motor manda", () => {
  for (const code of ["MUITOS_PEDIDOS_DE_CODIGO", "LIMITE_DIARIO_DE_CODIGOS", "EMAIL_NAO_CONFIGURADO", "ENVIO_DO_CODIGO_FALHOU", "SIGNUP_CLOSED"]) {
    assert.equal(authErrorMessage(new AuthError(code, 429, "Texto do motor.")), "Texto do motor.", code)
    const semMensagem = authErrorMessage(new AuthError(code, 503))
    assert.ok(semMensagem.length > 20 && !/undefined/.test(semMensagem), code)
  }
})

test("erros do código (mensagem em inglês no motor) viram texto de gente", () => {
  assert.match(authErrorMessage(new AuthError("INVALID_OTP", 400, "Invalid OTP")), /Código incorreto/)
  assert.match(authErrorMessage(new AuthError("OTP_EXPIRED", 400, "OTP expired")), /venceu.*código novo/)
  assert.match(authErrorMessage(new AuthError("TOO_MANY_ATTEMPTS", 403, "Too many attempts")), /código novo/)
  assert.match(authErrorMessage(new AuthError("INVALID_EMAIL", 400, "E-mail inválido.")), /Confira o e-mail/)
  assert.match(authErrorMessage(new AuthError("REQUEST_FAILED", 429)), /Aguarde um minuto/)
  assert.match(authErrorMessage(new AuthError("QUALQUER", 500, "Internal")), /Não foi possível concluir/)
  assert.match(authErrorMessage(new TypeError("fetch failed")), /conexão/)
  for (const code of ["INVALID_OTP", "OTP_EXPIRED", "TOO_MANY_ATTEMPTS"]) assert.doesNotMatch(authErrorMessage(new AuthError(code, 400)), /senha|link/i)
})

test("só tentativas esgotadas e código vencido pedem um código novo", () => {
  assert.equal(precisaDeCodigoNovo(new AuthError("TOO_MANY_ATTEMPTS", 403)), true)
  assert.equal(precisaDeCodigoNovo(new AuthError("OTP_EXPIRED", 400)), true)
  assert.equal(precisaDeCodigoNovo(new AuthError("INVALID_OTP", 400)), false)
  assert.equal(precisaDeCodigoNovo(new Error("x")), false)
})

test("authRequest guarda code, status e a mensagem do motor", async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => new Response(JSON.stringify({ code: "LIMITE_DIARIO_DE_CODIGOS", message: "Limite atingido." }), { status: 429 })
  await assert.rejects(authRequest("email-otp/send-verification-otp", { email: "a@b.test", type: "sign-in" }), error =>
    error instanceof AuthError && error.code === "LIMITE_DIARIO_DE_CODIGOS" && error.status === 429 && error.serverMessage === "Limite atingido.")
  globalThis.fetch = async () => new Response("não é json", { status: 429 })
  await assert.rejects(authRequest("sign-in/email-otp", { email: "a@b.test", otp: "123456" }), error =>
    error instanceof AuthError && error.code === "REQUEST_FAILED" && error.status === 429 && error.serverMessage === "")
})

/**
 * Calcula o ID de extensão do Chrome a partir do caminho da pasta.
 *
 * Por que isto existe: uma extensão carregada fora da Chrome Web Store tem o
 * ID derivado do caminho absoluto da pasta (SHA-256 do caminho, primeiros 16
 * bytes, nibbles 0-9a-f). O instalador cria a pasta, calcula este ID e grava
 * no serviço local — assim o usuário não precisa copiar ID nenhum e a origem
 * aceita é exatamente a da extensão que ele instalou.
 *
 * O algoritmo é documentado pelo Chromium (crx_file/id_util.cc). Isto NÃO é
 * criptografia de segurança: é derivação de identificador.
 */
import { createHash } from "node:crypto";

/** Caminho normalizado como o Chromium faz no Windows: minúsculas, barras invertidas. */
export function normalizeExtensionPath(dir) {
  return dir.replace(/\//g, "\\").toLowerCase().replace(/\\+$/, "");
}

/** Deriva o ID (32 caracteres a-p) do caminho da pasta da extensão. */
export function extensionIdFromPath(dir) {
  const hash = createHash("sha256").update(normalizeExtensionPath(dir), "utf8").digest("hex");
  return hash.slice(0, 32).replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]);
}

/** Origem completa para o allowlist do serviço local. */
export function extensionOriginFromPath(dir) {
  return `chrome-extension://${extensionIdFromPath(dir)}`;
}

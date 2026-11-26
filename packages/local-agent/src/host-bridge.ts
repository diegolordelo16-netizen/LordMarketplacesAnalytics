/**
 * Ponte para o protocolo de mensagens nativas. A implementação canônica vive em
 * @mi/native-host; aqui só reexportamos o necessário para o entry point, evitando
 * dependência circular entre os pacotes no bundle final.
 */
export { createFileLogger, encodeFrame, processFrames } from '@mi/native-host';
export type { HostLogger } from '@mi/native-host';

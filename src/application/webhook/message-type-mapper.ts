import type { MetaMessageType } from "../../domain/meta-webhook";

export type MessageType = "TEXT" | "AUDIO" | "IMAGE" | "DOCUMENT" | "STICKER" | "VIDEO";

const MAP: Partial<Record<MetaMessageType, MessageType>> = {
  text: "TEXT",
  audio: "AUDIO",
  image: "IMAGE",
  document: "DOCUMENT",
  sticker: "STICKER",
  video: "VIDEO",
  // Pedido do catálogo vira texto legível (ver catalog-service.ts#formatOrderText)
  // e segue o fluxo de mensagem digitada.
  order: "TEXT",
  // Localização e cliques em botão/lista também viram texto legível
  // (ver interactive-reply-service.ts).
  location: "TEXT",
  interactive: "TEXT",
  button: "TEXT",
};

/// Tipos sem correspondência direta (location/button/contacts) viram
/// DOCUMENT como aproximação — o AI-Worker trata qualquer tipo != "text" como
/// "formato não suportado" de qualquer forma, então a categoria exata só
/// importa para o histórico exibido no Agent Console.
export function mapMetaMessageType(type: MetaMessageType): MessageType {
  return MAP[type] ?? "DOCUMENT";
}

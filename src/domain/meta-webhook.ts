/// Formato do payload de webhook da Meta (WhatsApp Cloud API). Referência:
/// E:\Fluxy Gestão\.DEPRECADO\Orquestrador-meta (git history,
/// src/presentation/interfaces/meta.interface.ts).
export interface MetaWebhookBody {
  object: string;
  entry: MetaEntry[];
}

export interface MetaEntry {
  id: string;
  changes: MetaChange[];
}

export interface MetaChange {
  field: string;
  value: MetaChangeValue;
}

export interface MetaChangeValue {
  messaging_product: "whatsapp";
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: MetaContact[];
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
}

export interface MetaContact {
  profile: { name?: string };
  /// Telefone — a Meta omite quando o contato ativou @username e não há
  /// troca recente de telefone (ver MetaMessage.from_user_id).
  wa_id?: string;
  /// Business-Scoped User ID — presente em todo webhook desde abr/2026,
  /// independente de @username. Vínculo principal do contato (ver
  /// application/webhook/target-service.ts#resolveOrCreateTarget).
  user_id?: string;
}

export type MetaMessageType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "location"
  | "button"
  | "contacts"
  /// Carrinho enviado pelo contato a partir de uma mensagem de catálogo/produto.
  | "order"
  /// Clique em botão de resposta / item de lista enviados pelo agente.
  | "interactive";

/// Objeto de mídia dentro de messages[] — a Meta manda só o id (o arquivo em si
/// precisa ser baixado com o token do canal, ver media-service.ts).
export interface MetaMedia {
  id: string;
  mime_type?: string;
  sha256?: string;
  /// image/video/document
  caption?: string;
  /// document
  filename?: string;
  /// audio: true quando é mensagem de voz gravada no app
  voice?: boolean;
}

/// messages[].order — a Meta manda só o SKU (product_retailer_id); preço e
/// quantidade podem vir como número ou string, dependendo da versão.
export interface MetaOrder {
  catalog_id?: string;
  text?: string;
  product_items?: {
    product_retailer_id: string;
    quantity?: number | string;
    item_price?: number | string;
    currency?: string;
  }[];
}

/// messages[].location — latitude/longitude são números; name/address só
/// vêm se o contato escolher compartilhar.
export interface MetaLocation {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

export interface MetaMessage {
  /// Telefone do remetente — opcional pelo mesmo motivo de MetaContact.wa_id.
  from?: string;
  /// BSUID do remetente — espelha MetaContact.user_id, presente direto no
  /// próprio objeto de mensagem.
  from_user_id?: string;
  id: string;
  timestamp: string;
  type: MetaMessageType;
  text?: { body?: string };
  image?: MetaMedia;
  audio?: MetaMedia;
  video?: MetaMedia;
  document?: MetaMedia;
  sticker?: MetaMedia;
  order?: MetaOrder;
  location?: MetaLocation;
  interactive?: {
    type: "button_reply" | "list_reply" | string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
    /// Resposta de um WhatsApp Flow: response_json é um JSON (string) com os
    /// campos do formulário e o flow_token enviado.
    nfm_reply?: { name?: string; body?: string; response_json?: string };
  };
  /// Resposta rápida de template/carrossel (type="button").
  button?: { text?: string; payload?: string };
  /// Mensagem do negócio que o contato respondeu (ou que gerou o clique).
  context?: { from?: string; id?: string };
}

export interface MetaStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  recipient_id: string;
  /// BSUID do destinatário — usado pra atualizar/corrigir Target.bsuid
  /// quando o contato foi originalmente alcançado só por telefone (disparo
  /// ativo de campanha, ver Notification-Worker/update-message-status.ts).
  recipient_user_id?: string;
}

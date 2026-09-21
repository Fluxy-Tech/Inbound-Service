import { randomUUID } from "crypto";
import path from "path";
import type { MetaMedia, MetaMessage } from "../../domain/meta-webhook";
import { inboundMediaKey, uploadInboundMedia } from "../../infrastructure/storage/s3-client";

const GRAPH_API_BASE = "https://graph.facebook.com/v22.0";
const DOWNLOAD_TIMEOUT_MS = 30_000;
/// Teto de segurança por tipo (o arquivo inteiro fica em memória durante o
/// download). A Meta limita áudio/vídeo a 16MB, imagem a 5MB e figurinha a
/// 500KB; documento chega a 100MB, mas aqui cortamos em 50MB pra não estourar
/// a memória do serviço.
const DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/// Só os tipos que trazem arquivo — location/button/contacts não têm mídia.
function pickMedia(message: MetaMessage): MetaMedia | undefined {
  if (message.type === "image") return message.image;
  if (message.type === "audio") return message.audio;
  if (message.type === "video") return message.video;
  if (message.type === "document") return message.document;
  if (message.type === "sticker") return message.sticker;
  return undefined;
}

/// "audio/ogg; codecs=opus" → "audio/ogg".
function baseMimeType(mimeType: string): string {
  return mimeType.split(";")[0].trim().toLowerCase();
}

/// Texto da mensagem de mídia — vira `text` do documento Mongo, mesma
/// convenção do envio do atendente (Outbound-Worker grava o caption em `text`
/// e, no documento, o nome do arquivo). Documento usa o nome do arquivo (é o
/// que o console mostra no link), com a legenda como reserva.
export function extractMediaText(message: MetaMessage): string {
  const media = pickMedia(message);
  if (!media) return "";
  if (message.type === "document") return media.filename ?? media.caption ?? "";
  return media.caption ?? "";
}

export function hasDownloadableMedia(message: MetaMessage): boolean {
  return pickMedia(message) !== undefined;
}

/// Baixa a mídia da Meta (2 passos: o id vira uma URL temporária, e essa URL
/// só responde com o mesmo Bearer token) e guarda no S3. Devolve a URL pública
/// ou undefined quando algo falha — a mensagem NUNCA deve ser perdida por
/// causa da mídia, então o chamador segue sem mediaUrl (os consoles mostram
/// "Mídia indisponível").
export async function storeInboundMedia(input: {
  message: MetaMessage;
  accessToken: string | null;
  organizationId: string;
  targetId: string;
}): Promise<string | undefined> {
  const media = pickMedia(input.message);
  if (!media) return undefined;

  if (!input.accessToken) {
    console.warn(`[MEDIA][media-service] messageId=${input.message.id} canal sem token da Meta — mídia não baixada.`);
    return undefined;
  }

  try {
    const authHeaders = { Authorization: `Bearer ${input.accessToken}` };

    const metaResponse = await fetch(`${GRAPH_API_BASE}/${media.id}`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!metaResponse.ok) throw new Error(`Meta respondeu ${metaResponse.status} ao resolver a mídia ${media.id}`);

    const info = (await metaResponse.json()) as { url?: string; mime_type?: string; file_size?: number };
    if (!info.url) throw new Error(`Meta não devolveu a URL da mídia ${media.id}`);
    const maxBytes = input.message.type === "document" ? MAX_DOCUMENT_BYTES : DEFAULT_MAX_MEDIA_BYTES;
    if (info.file_size && info.file_size > maxBytes) {
      throw new Error(`Mídia ${media.id} excede o limite (${info.file_size} bytes)`);
    }

    const fileResponse = await fetch(info.url, { headers: authHeaders, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!fileResponse.ok) throw new Error(`Download da mídia ${media.id} respondeu ${fileResponse.status}`);

    const body = Buffer.from(await fileResponse.arrayBuffer());
    if (body.byteLength > maxBytes) throw new Error(`Mídia ${media.id} excede o limite (${body.byteLength} bytes)`);

    const mimeType = baseMimeType(info.mime_type ?? media.mime_type ?? "application/octet-stream");
    // Documento mantém a extensão original do arquivo quando a Meta a informa
    // (ex: .xlsx, .zip) — o mapa acima só cobre os tipos mais comuns.
    const originalExtension = media.filename ? path.extname(media.filename).slice(1).toLowerCase() : "";
    const extension = /^[a-z0-9]{1,8}$/.test(originalExtension) ? originalExtension : EXTENSION_BY_MIME[mimeType];
    const fileName = extension ? `${randomUUID()}.${extension}` : randomUUID();

    return await uploadInboundMedia({
      key: inboundMediaKey({ organizationId: input.organizationId, targetId: input.targetId, fileName }),
      body,
      contentType: mimeType,
    });
  } catch (error) {
    console.error(`[MEDIA][media-service] messageId=${input.message.id} falha ao guardar a mídia:`, error);
    return undefined;
  }
}

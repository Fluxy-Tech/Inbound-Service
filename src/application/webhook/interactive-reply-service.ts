import type { Prisma } from "../../../generated/prisma/client";
import type { MetaLocation, MetaMessage } from "../../domain/meta-webhook";
import { prisma } from "../../infrastructure/database/prisma/client";

/// Chave do metadado onde a localização compartilhada pelo contato fica salva
/// (funcionalidade "Solicitar localização" do agente).
export const LOCATION_METADATA_KEY = "localization";

function locationValue(location: MetaLocation): string {
  const coords = `${location.latitude},${location.longitude}`;
  const place = [location.name, location.address].filter(Boolean).join(", ");
  return place ? `${place} (${coords})` : coords;
}

/// Texto que segue pro agente/histórico quando o contato compartilha a
/// localização (resposta ao pedido de localização ou envio espontâneo).
export function describeLocation(location: MetaLocation): string {
  return `📍 Localização enviada pelo contato: ${locationValue(location)}\nhttps://maps.google.com/?q=${location.latitude},${location.longitude}`;
}

/// Salva a localização em Target.metadata.localization (sem apagar o resto) e
/// devolve o metadata atualizado, pro payload do agente já sair com ele.
export async function saveLocationMetadata(
  targetId: string,
  currentMetadata: Prisma.JsonValue | null,
  location: MetaLocation,
): Promise<Prisma.JsonObject> {
  const base =
    currentMetadata && typeof currentMetadata === "object" && !Array.isArray(currentMetadata)
      ? (currentMetadata as Prisma.JsonObject)
      : {};
  const metadata = { ...base, [LOCATION_METADATA_KEY]: locationValue(location) };
  await prisma.target.update({ where: { id: targetId }, data: { metadata } });
  return metadata;
}

/// Clique do contato numa mensagem interativa enviada pelo agente — botão de
/// resposta, item de lista ou botão de resposta rápida (carrossel/template).
/// O id do botão/opção vai junto pro agente saber exatamente o que foi escolhido.
export function describeInteractiveReply(message: MetaMessage): string {
  const interactive = message.interactive;
  if (interactive?.type === "button_reply" && interactive.button_reply) {
    return `🔘 Clicou no botão: ${interactive.button_reply.title} (id: ${interactive.button_reply.id})`;
  }
  if (interactive?.type === "list_reply" && interactive.list_reply) {
    const { title, description, id } = interactive.list_reply;
    return `📋 Escolheu na lista: ${title}${description ? ` - ${description}` : ""} (id: ${id})`;
  }
  if (message.button?.text) {
    return `🔘 Clicou no botão: ${message.button.text}${message.button.payload ? ` (id: ${message.button.payload})` : ""}`;
  }
  return "";
}

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

/// Prefixo do flow_token dos Flows enviados pelo agente:
/// "sturnus:<id da funcionalidade>:<aleatório>" (ver funcionalidades.py).
const FLOW_TOKEN_PREFIX = "sturnus:";

/// Marcador de Flow respondido em Target.metadata: "flow_respondido_<id da
/// funcionalidade>" = data/hora da resposta. Só com "salvar como metadados"
/// ligado — é o que o AI-Worker lê pra saber que o Flow da coleta já foi
/// respondido, mesmo numa sessão nova (precisa bater com
/// CHAVE_FLOW_RESPONDIDO em funcionalidades.py).
export const FLOW_ANSWERED_METADATA_PREFIX = "flow_respondido_";

function answeredAt(): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  })
    .format(new Date())
    .replace(",", "");
}

function flowFieldValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(flowFieldValue).join(", ");
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "");
}

/// Resposta de um WhatsApp Flow (interactive.nfm_reply). Devolve o texto que
/// segue pro agente (com o id da funcionalidade, como nos cliques de botão) e,
/// quando a funcionalidade tem "salvar como metadados" ligado, grava cada
/// campo e o marcador de respondido em Target.metadata (sem apagar o resto).
export async function handleFlowReply(
  target: { id: string; organizationId: string; metadata: Prisma.JsonValue | null },
  message: MetaMessage,
): Promise<{ text: string; metadata?: Prisma.JsonObject }> {
  let response: Record<string, unknown> = {};
  try {
    response = JSON.parse(message.interactive?.nfm_reply?.response_json ?? "{}") as Record<string, unknown>;
  } catch {
    console.warn(`[flow] response_json inválido na mensagem ${message.id}`);
  }

  const token = typeof response.flow_token === "string" ? response.flow_token : "";
  const fields = Object.entries(response)
    .filter(([key]) => key !== "flow_token")
    .map(([key, value]) => [key, flowFieldValue(value)] as const)
    .filter(([, value]) => value !== "");

  const featureId = token.startsWith(FLOW_TOKEN_PREFIX) ? token.slice(FLOW_TOKEN_PREFIX.length).split(":")[0] : "";
  const feature = featureId
    ? await prisma.agentFeature.findFirst({
        where: { id: featureId, type: "FLOW", agent: { organizationId: target.organizationId } },
        select: { name: true, config: true },
      })
    : null;
  const config = (feature?.config ?? {}) as { flowName?: string; saveAsMetadata?: boolean };

  const title = config.flowName || feature?.name || "formulário";
  const lines = fields.map(([key, value]) => `- ${key}: ${value}`);
  const id = feature ? ` (id: ${featureId})` : "";
  let text = `📝 Respondeu o formulário "${title}"${id}${lines.length ? `:\n${lines.join("\n")}` : " (sem campos preenchidos)."}`;

  if (!feature || !config.saveAsMetadata) return { text };

  const base =
    target.metadata && typeof target.metadata === "object" && !Array.isArray(target.metadata)
      ? (target.metadata as Prisma.JsonObject)
      : {};
  const metadata: Prisma.JsonObject = {
    ...base,
    ...Object.fromEntries(fields),
    [`${FLOW_ANSWERED_METADATA_PREFIX}${featureId}`]: answeredAt(),
  };
  await prisma.target.update({ where: { id: target.id }, data: { metadata } });
  if (fields.length) text += "\n(Respostas salvas nos metadados do contato.)";
  return { text, metadata };
}

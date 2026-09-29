import type { Channel } from "amqplib";
import type { MetaContact, MetaMessage } from "../../domain/meta-webhook";
import { tryDecryptToken } from "../../infrastructure/crypto/token-cipher";
import { prisma } from "../../infrastructure/database/prisma/client";
import {
  publishJson,
  QUEUE_DESK_MESSAGE_INBOUND,
  QUEUE_OUTBOUND_MESSAGE_SEND,
  resolveAgentQueueName,
} from "../../infrastructure/queue/rabbitmq/publisher";
import { extractMediaText, hasDownloadableMedia, storeInboundMedia } from "./media-service";
import { handleCampaignResponse } from "./campaign-response-service";
import { isMessageAlreadyProcessed, markMessageProcessed } from "./dedup-service";
import { popDebounceWindow, pushToDebounceWindow } from "./debounce-service";
import { recordMessageLog } from "./message-log-service";
import { mapMetaMessageType } from "./message-type-mapper";
import { resolveOrCreateMessagingSession } from "./messaging-session-service";
import { saveInboundMessage } from "./mongo-message-service";
import { isSessionProcessing, markSessionProcessing } from "./processing-state-service";
import { AGENT_WITH_METADATA_FIELDS, resolveOrCreateTarget, resolveChannel } from "./target-service";
import { requestTypingIndicator } from "./typing-indicator-service";

function agentPayload(agent: {
  id: string;
  name: string;
  processingMessage: string;
  transferMessage: string;
  unsupportedFormatMessage: string;
  outOfHoursMessage: string;
  outOfHoursEnabled: boolean;
  closingMessage: string;
  closingEnabled: boolean;
  errorMessage: string;
  errorEnabled: boolean;
  defaultQueueId: string | null;
  personality: string | null;
  ragEnabled: boolean;
  openaiTokenEncrypted: string | null;
  geminiTokenEncrypted: string | null;
  metadataFields: { name: string; nameToAgent: string; rule: string }[];
  functions: { type: string; runAtStart: boolean; runAfterMetadata: boolean }[];
}) {
  return {
    id: agent.id,
    name: agent.name,
    processingMessage: agent.processingMessage,
    transferMessage: agent.transferMessage,
    unsupportedFormatMessage: agent.unsupportedFormatMessage,
    outOfHoursMessage: agent.outOfHoursMessage,
    outOfHoursEnabled: agent.outOfHoursEnabled,
    closingMessage: agent.closingMessage,
    closingEnabled: agent.closingEnabled,
    errorMessage: agent.errorMessage,
    errorEnabled: agent.errorEnabled,
    defaultQueueId: agent.defaultQueueId,
    // Só consumidos pelo worker "max" — atlas/axel ignoram, já que têm
    // personalidade/RAG fixos em código.
    personality: agent.personality,
    ragEnabled: agent.ragEnabled,
    // Só os ativos (ver AGENT_WITH_METADATA_FIELDS) — hoje só o piloto coleta.
    metadataFields: agent.metadataFields.map((f) => ({ name: f.name, nameToAgent: f.nameToAgent, rule: f.rule })),
    // Funções fixas ligadas no Console (CALENDAR_EVENT/KANBAN_CARD) e em que
    // momento rodam — sem linha no banco = desligada, então nem aparece aqui.
    functions: agent.functions.map((f) => ({
      type: f.type,
      runAtStart: f.runAtStart,
      runAfterMetadata: f.runAfterMetadata,
    })),
    // Decifrados aqui mesmo, na borda de publicação — o AI-Worker usa esses
    // valores direto (nunca mais do próprio env do processo). Token ausente
    // ou cifrado com chave divergente vira null (tryDecryptToken loga e não
    // derruba a mensagem); o worker trata a ausência do seu lado.
    openaiToken: tryDecryptToken(agent.openaiTokenEncrypted, `openaiToken do agente ${agent.id}`),
    geminiToken: tryDecryptToken(agent.geminiTokenEncrypted, `geminiToken do agente ${agent.id}`),
  };
}

export async function handleInboundMessage(
  channel: Channel,
  phoneNumberId: string,
  message: MetaMessage,
  contact: MetaContact | undefined,
): Promise<void> {
  if (await isMessageAlreadyProcessed(message.id)) {
    console.log(`Mensagem duplicada ignorada: ${message.id}`);
    return;
  }

  const whatsappChannel = await resolveChannel(phoneNumberId);
  if (!whatsappChannel) {
    console.warn(`Mensagem recebida para phoneNumberId não cadastrado: ${phoneNumberId}`);
    return;
  }

  // whatsappChannelId aqui é sempre o id interno (nunca o phoneNumberId da
  // Meta) — só dá pra saber depois de resolver o canal, por isso o registro
  // definitivo de dedup acontece aqui, não antes.
  if (await markMessageProcessed(message.id, whatsappChannel.id)) {
    console.log(`Mensagem duplicada ignorada (corrida concorrente): ${message.id}`);
    return;
  }

  // externalMessageId (wamid) é o único id que já existe neste ponto — o
  // mongoMessageId só nasce depois de saveInboundMessage, mais abaixo.
  await recordMessageLog(message.id, "start");

  const target = await resolveOrCreateTarget({
    organizationId: whatsappChannel.organizationId,
    whatsappChannelId: whatsappChannel.id,
    bsuid: contact?.user_id ?? message.from_user_id,
    waId: contact?.wa_id ?? message.from,
    name: contact?.profile?.name,
  });

  const messageType = mapMetaMessageType(message.type);
  // Imagem/vídeo trazem a legenda como texto da mensagem, documento o nome do
  // arquivo; áudio e figurinha não têm texto.
  const text = message.type === "text" ? (message.text?.body ?? "") : extractMediaText(message);

  // Assíncrono de propósito (sem await) — vincula a resposta a uma campanha
  // pendente e avalia bloqueio por frase, sem atrasar o roteamento da
  // mensagem. Ver campaign-response-service.ts.
  handleCampaignResponse(
    target.id,
    {
      id: whatsappChannel.id,
      useWordsToBlockCampaign: whatsappChannel.useWordsToBlockCampaign,
      wordsToBlockCampaign: whatsappChannel.wordsToBlockCampaign,
    },
    text,
  );

  // Resolve a sessão ANTES de gravar no Mongo — o documento precisa do
  // messagingSessionId final desde a criação, sem update pontual depois.
  const messagingSession = await resolveOrCreateMessagingSession({
    targetId: target.id,
    whatsappChannelId: whatsappChannel.id,
  });

  // Imagem/áudio/vídeo/documento/figurinha: baixa da Meta e guarda no S3 antes de gravar o
  // documento, pra ele já nascer com o mediaUrl (portal e Desk só leem daqui).
  // Falha no download não derruba a mensagem — segue sem mediaUrl.
  const mediaUrl = hasDownloadableMedia(message)
    ? await storeInboundMedia({
        message,
        accessToken: whatsappChannel.metaAccessToken,
        organizationId: whatsappChannel.organizationId,
        targetId: target.id,
      })
    : undefined;

  const mongoMessageId = await saveInboundMessage({
    organizationId: whatsappChannel.organizationId,
    targetId: target.id,
    whatsappChannelId: whatsappChannel.id,
    messagingSessionId: messagingSession.id,
    messageType,
    externalMessageId: message.id,
    text,
    mediaUrl,
  });

  const targetPayload = { id: target.id, waId: target.waId, name: target.name, metadata: target.metadata };
  const whatsappChannelPayload = {
    id: whatsappChannel.id,
    phoneNumberId: whatsappChannel.phoneNumberId,
    wabaId: whatsappChannel.wabaId,
    serviceIslandId: whatsappChannel.serviceIsland?.id ?? null,
    wordsToReset: whatsappChannel.wordsToReset,
    resetMessage: whatsappChannel.resetMessage,
  };
  const messagingSessionPayload = { id: messagingSession.id, startedAt: messagingSession.startedAt };

  // Bloqueio (Agent-Console > Contatos > cadeado): contato explicitamente
  // impedido de falar com este agente — nem IA, nem atendente. A mensagem já
  // foi salva no Mongo acima (fica no histórico), só não é roteada adiante.
  // Só faz sentido quando existe agente vinculado ao canal.
  if (whatsappChannel.agent && target.blockedAgentIds.includes(whatsappChannel.agent.id)) {
    console.log(
      `[BLOCKED][webhook-service] targetId=${target.id} agentId=${whatsappChannel.agent.id} — contato bloqueado para este agente`,
    );
    await publishJson(channel, QUEUE_OUTBOUND_MESSAGE_SEND, {
      target: targetPayload,
      channel: whatsappChannelPayload,
      messagingSession: messagingSessionPayload,
      answer: { text: whatsappChannel.agent.blockedMessage, audio: "", image: "" },
      finishesProcessing: true,
      origin: "SYSTEM",
    });
    await recordMessageLog(mongoMessageId, "end");
    return;
  }

  // target.status === "HUMAN" (ticket já aberto) ou canal sem agente
  // ativo (openAgent=false, ou sem nenhum agente vinculado — inconsistente,
  // mas tratado como desligado por segurança) nunca passa pela IA, vai
  // direto pro Desk-Worker abrir/atualizar o ticket na fila idServiceIslandDefault.
  if (target.status === "HUMAN" || !whatsappChannel.openAgent || !whatsappChannel.agent) {
    console.log(
      `[DESK-MSG][webhook-service] targetId=${target.id} status=${target.status} openAgent=${whatsappChannel.openAgent} — roteando para desk.message.inbound`,
    );
    await publishJson(channel, QUEUE_DESK_MESSAGE_INBOUND, {
      target: targetPayload,
      channel: whatsappChannelPayload,
      messagingSession: messagingSessionPayload,
      agent: whatsappChannel.agent ? { id: whatsappChannel.agent.id, name: whatsappChannel.agent.name } : null,
      defaultQueueId: whatsappChannel.idServiceIslandDefault,
      message: { mongoMessageId, externalMessageId: message.id, type: messageType, text, timestamp: message.timestamp },
    });
    await recordMessageLog(mongoMessageId, "end");
    return;
  }

  const agent = whatsappChannel.agent;

  // "AI" e "FINISHED" seguem para o pipeline de IA — não existe ainda regra de
  // produto para reengajamento automático de uma conversa "FINISHED" (mesmo
  // gap do sistema deprecado), então tratamos igual a "AI" por ora.
  if (message.type !== "text") {
    await markSessionProcessing(messagingSession.id);
    await requestTypingIndicator(channel, whatsappChannel.id, whatsappChannel.phoneNumberId, message.id);
    await publishJson(channel, resolveAgentQueueName(agent.name), {
      target: targetPayload,
      channel: whatsappChannelPayload,
      agent: agentPayload(agent),
      messagingSession: messagingSessionPayload,
      messages: [{ mongoMessageId, externalMessageId: message.id, type: messageType, text, timestamp: message.timestamp }],
    });
    await recordMessageLog(mongoMessageId, "end");
    return;
  }

  const { isFirstInWindow } = await pushToDebounceWindow(messagingSession.id, {
    mongoMessageId,
    externalMessageId: message.id,
    type: "TEXT",
    text,
    timestamp: message.timestamp,
  });

  // processingMessage só faz sentido como aviso de "cheguei em cima de algo
  // que já está rodando" — só dispara se (a) esta mensagem abre uma janela de
  // agrupamento nova E (b) já existe um lote anterior daquela sessão em
  // processamento no AI-Worker. Mensagem de abertura de conversa (ou
  // qualquer turno sem sobreposição) não deve gerar esse aviso.
  if (isFirstInWindow && (await isSessionProcessing(messagingSession.id))) {
    console.log(
      `[DESK-MSG][webhook-service] targetId=${target.id} status=${target.status} sessão em processamento — enviando processingMessage`,
    );
    await publishJson(channel, QUEUE_OUTBOUND_MESSAGE_SEND, {
      target: targetPayload,
      channel: whatsappChannelPayload,
      messagingSession: messagingSessionPayload,
      answer: { text: agent.processingMessage, audio: "", image: "" },
      finishesProcessing: false,
      origin: "SYSTEM",
    });
  }
}

/// Chamado pelo debounce worker quando a janela de 10s de uma sessão fecha —
/// re-resolve o contexto (sessão → target → canal → agente) porque o flush
/// acontece de forma assíncrona e desacoplada da requisição HTTP original.
export async function flushDebounceWindow(channel: Channel, messagingSessionId: string): Promise<void> {
  const messages = await popDebounceWindow(messagingSessionId);
  if (messages.length === 0) return;

  const messagingSession = await prisma.messagingSession.findUnique({
    where: { id: messagingSessionId },
    include: {
      target: { include: { whatsappChannel: { include: { agent: AGENT_WITH_METADATA_FIELDS, serviceIsland: true } } } },
    },
  });

  if (!messagingSession) {
    console.warn(`Janela de debounce fechou para sessão inexistente: ${messagingSessionId}`);
    return;
  }

  const target = messagingSession.target;
  const whatsappChannel = target.whatsappChannel;
  const whatsappChannelPayload = {
    id: whatsappChannel.id,
    phoneNumberId: whatsappChannel.phoneNumberId,
    wabaId: whatsappChannel.wabaId,
    serviceIslandId: whatsappChannel.serviceIsland?.id ?? null,
    wordsToReset: whatsappChannel.wordsToReset,
    resetMessage: whatsappChannel.resetMessage,
  };

  // Mesmo bloqueio checado em handleInboundMessage — precisa repetir aqui
  // porque o flush é assíncrono/desacoplado: o estado de bloqueio pode ter
  // mudado entre a mensagem chegar e a janela de debounce fechar.
  if (whatsappChannel.agent && target.blockedAgentIds.includes(whatsappChannel.agent.id)) {
    console.log(
      `[BLOCKED][webhook-service] (flush) targetId=${target.id} agentId=${whatsappChannel.agent.id} — contato bloqueado para este agente`,
    );
    await publishJson(channel, QUEUE_OUTBOUND_MESSAGE_SEND, {
      target: { id: target.id, waId: target.waId, name: target.name, metadata: target.metadata },
      channel: whatsappChannelPayload,
      messagingSession: { id: messagingSession.id, startedAt: messagingSession.startedAt },
      answer: { text: whatsappChannel.agent.blockedMessage, audio: "", image: "" },
      finishesProcessing: true,
      origin: "SYSTEM",
    });
    await Promise.all(messages.map((m) => recordMessageLog(m.mongoMessageId, "end")));
    return;
  }

  // Mesma checagem de handleInboundMessage: canal pode ter sido desativado
  // (openAgent virou false, ou o agente foi desvinculado) entre a mensagem
  // chegar e a janela de debounce fechar — nesse caso o lote inteiro vai pro
  // Desk-Worker em vez do agente, usando a última mensagem como gatilho.
  if (target.status === "HUMAN" || !whatsappChannel.openAgent || !whatsappChannel.agent) {
    const last = messages[messages.length - 1];
    console.log(
      `[DESK-MSG][webhook-service] (flush) targetId=${target.id} status=${target.status} openAgent=${whatsappChannel.openAgent} — roteando para desk.message.inbound`,
    );
    await publishJson(channel, QUEUE_DESK_MESSAGE_INBOUND, {
      target: { id: target.id, waId: target.waId, name: target.name, metadata: target.metadata },
      channel: whatsappChannelPayload,
      messagingSession: { id: messagingSession.id, startedAt: messagingSession.startedAt },
      agent: whatsappChannel.agent ? { id: whatsappChannel.agent.id, name: whatsappChannel.agent.name } : null,
      defaultQueueId: whatsappChannel.idServiceIslandDefault,
      message: { mongoMessageId: last.mongoMessageId, externalMessageId: last.externalMessageId, type: last.type, text: last.text, timestamp: last.timestamp },
    });
    await Promise.all(messages.map((m) => recordMessageLog(m.mongoMessageId, "end")));
    return;
  }

  const agent = whatsappChannel.agent;

  await markSessionProcessing(messagingSessionId);
  await requestTypingIndicator(channel, whatsappChannel.id, whatsappChannel.phoneNumberId, messages[messages.length - 1].externalMessageId);
  await publishJson(channel, resolveAgentQueueName(agent.name), {
    target: { id: target.id, waId: target.waId, name: target.name, metadata: target.metadata },
    channel: whatsappChannelPayload,
    agent: agentPayload(agent),
    messagingSession: { id: messagingSession.id, startedAt: messagingSession.startedAt },
    messages,
  });
  await Promise.all(messages.map((m) => recordMessageLog(m.mongoMessageId, "end")));
}

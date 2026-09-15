import { prisma } from "../../infrastructure/database/prisma/client";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/// Mensagem bate com uma das frases de bloqueio quando é EXATAMENTE igual
/// (normalizada) a uma delas — mesmo critério de Channel.wordsToReset, pra
/// não bloquear por engano numa frase que só contenha uma das palavras.
function matchesBlockPhrase(text: string, phrases: string[]): boolean {
  const normalizedText = normalize(text);
  if (!normalizedText) return false;
  return phrases.map(normalize).includes(normalizedText);
}

/// Vincula a mensagem recebida do cliente ao disparo de campanha ainda sem
/// resposta (se houver) e, quando o canal tem o bloqueio automático por
/// frase ativado, verifica se a resposta bate com uma das frases
/// configuradas — se bater, marca o contato como bloqueado de futuras
/// campanhas NESTE canal (ver Channel.wordsToBlockCampaign/
/// useWordsToBlockCampaign e TargetBlockCampaign no schema).
///
/// Fire-and-forget de propósito — chamado sem await em handleInboundMessage,
/// nunca deve atrasar nem derrubar o processamento do webhook. Quando há mais
/// de um CampaignTarget pendente pro mesmo contato, vincula ao disparo mais
/// recente.
export function handleCampaignResponse(
  targetId: string,
  channel: { id: string; useWordsToBlockCampaign: boolean; wordsToBlockCampaign: string[] },
  text: string,
): void {
  prisma.campaignTarget
    .findFirst({
      where: { targetId, respondedCampaign: false },
      orderBy: { createdAt: "desc" },
    })
    .then(async (campaignTarget) => {
      if (!campaignTarget) return;

      await prisma.campaignTarget.update({
        where: { id: campaignTarget.id },
        data: { respondedCampaign: true, campaignResponse: text },
      });

      if (!channel.useWordsToBlockCampaign) return;
      if (!matchesBlockPhrase(text, channel.wordsToBlockCampaign)) return;

      await prisma.targetBlockCampaign.upsert({
        where: { targetId_whatsappChannelId: { targetId, whatsappChannelId: channel.id } },
        create: { targetId, whatsappChannelId: channel.id },
        update: {},
      });
    })
    .catch((error) => {
      console.error(
        `[CAMPAIGN-RESPONSE][campaign-response-service] targetId=${targetId} — falha ao processar resposta da campanha:`,
        error,
      );
    });
}

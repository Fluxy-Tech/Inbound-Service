import { prisma } from "../../infrastructure/database/prisma/client";

/// Cria o CardCrm do lead recém-criado, sempre no estágio "Início"
/// (isDefault=true) da empresa. Fire-and-forget de propósito — chamado sem
/// await em target-service.ts#resolveOrCreateTarget, nunca deve atrasar nem
/// derrubar o processamento do webhook (mesmo padrão de
/// campaign-response-service.ts#handleCampaignResponse).
export function createCardCrmForTarget(targetId: string, organizationId: string): void {
  prisma.crmToBusiness
    .findUnique({ where: { organizationId } })
    .then(async (crm) => {
      // Empresa criada antes desta feature existir — sem CRM ainda, não há
      // onde criar o card. Não derruba nada, só não cria o card.
      if (!crm) {
        console.warn(`[CRM-CARD][crm-card-service] organizationId=${organizationId} sem CrmToBusiness — pulando.`);
        return;
      }

      // Idempotência pedida no requisito: nunca duplicar o card de um Target.
      const existingCard = await prisma.cardCrm.findUnique({ where: { targetId } });
      if (existingCard) return;

      const inicio = await prisma.stagesCrm.findFirst({ where: { crmToBusinessId: crm.id, isDefault: true } });
      if (!inicio) {
        console.error(`[CRM-CARD][crm-card-service] crmToBusinessId=${crm.id} sem estágio "Início" — pulando.`);
        return;
      }

      await prisma.cardCrm.create({
        data: { targetId, crmToBusinessId: crm.id, stagesCrmId: inicio.id },
      });
    })
    .catch((error) => {
      console.error(`[CRM-CARD][crm-card-service] targetId=${targetId} — falha ao criar CardCrm:`, error);
    });
}

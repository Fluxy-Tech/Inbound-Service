import { redis } from "../../infrastructure/cache/redis/client";

function markerKey(messagingSessionId: string): string {
  return `debounce:session:${messagingSessionId}`;
}

function queueKey(messagingSessionId: string): string {
  return `debounce:session:${messagingSessionId}:queue`;
}

export interface DebouncedMessage {
  mongoMessageId: string;
  externalMessageId: string;
  type: "TEXT";
  text: string;
  timestamp: string;
}

/// Agrupamento por sessão com janela de windowSeconds (Channel.messageWaitSeconds,
/// configurável por canal) que reinicia a cada mensagem nova. RPUSH acumula em ordem de chegada; o SET com
/// GET diz se essa é a PRIMEIRA mensagem da janela (pra decidir se manda a
/// processingMessage imediata) e sempre reseta o TTL, seja janela nova ou não.
export async function pushToDebounceWindow(
  messagingSessionId: string,
  message: DebouncedMessage,
  windowSeconds: number,
): Promise<{ isFirstInWindow: boolean }> {
  await redis.rpush(queueKey(messagingSessionId), JSON.stringify(message));
  const previous = await redis.set(markerKey(messagingSessionId), "1", "EX", Math.max(1, windowSeconds), "GET");
  return { isFirstInWindow: previous === null };
}

export async function popDebounceWindow(messagingSessionId: string): Promise<DebouncedMessage[]> {
  const key = queueKey(messagingSessionId);
  const raw = await redis.lrange(key, 0, -1);
  await redis.del(key);
  return raw.map((item) => JSON.parse(item) as DebouncedMessage);
}

export function extractSessionIdFromMarkerKey(key: string): string | null {
  const match = key.match(/^debounce:session:(.+)$/);
  if (!match) return null;
  // A chave da lista (":queue") também bate nesse regex — ela nunca expira
  // (sem TTL), então só a marcadora dispara o evento "expired", mas o regex
  // sozinho não distingue; o filtro real é feito no listener (ver
  // redis-debounce-worker.ts), que só reage a eventos "expired" de verdade.
  return match[1];
}

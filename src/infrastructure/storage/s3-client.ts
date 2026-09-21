import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "../../config/env";

const client = new S3Client({
  endpoint: env.SEAWEEDFS_S3_ENDPOINT,
  region: env.SEAWEEDFS_S3_REGION,
  credentials: {
    accessKeyId: env.SEAWEEDFS_S3_ACCESS_KEY,
    secretAccessKey: env.SEAWEEDFS_S3_SECRET_KEY,
  },
  // SeaweedFS não faz roteamento por subdomínio de bucket — precisa de
  // path-style (host/bucket/key). Mesmo padrão do Agent-Api/Desk-API.
  forcePathStyle: true,
});

/// Sobe a mídia recebida do cliente pro S3 e devolve a URL que fica gravada no
/// documento Mongo (mediaUrl) — mesmo formato `<endpoint>/<bucket>/<key>` que o
/// Desk-API usa nos anexos do atendente, então os consoles tratam os dois
/// igual.
export async function uploadInboundMedia(input: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<string> {
  await client.send(
    new PutObjectCommand({
      Bucket: env.SEAWEEDFS_S3_BUCKET,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
    }),
  );

  return `${env.SEAWEEDFS_S3_ENDPOINT}/${env.SEAWEEDFS_S3_BUCKET}/${input.key}`;
}

export function inboundMediaKey(input: { organizationId: string; targetId: string; fileName: string }): string {
  return `${env.SEAWEEDFS_S3_PREFIX}/inbound-media/${input.organizationId}/${input.targetId}/${input.fileName}`;
}

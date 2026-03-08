import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'crypto';
import { logger } from '@uniflow/logger';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.PROFILE_TABLE_NAME!;

const log = logger.child({ service: 'authorizer' });

// In-memory cache: writeKeyHash -> sourceId (TTL 5 min)
const cache = new Map<string, { sourceId: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function hashWriteKey(writeKey: string): string {
  return createHash('sha256').update(writeKey).digest('hex');
}

function extractWriteKey(event: APIGatewayRequestAuthorizerEventV2): string | null {
  // Check Authorization header: "Basic base64(writeKey:)" or "Bearer writeKey"
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!authHeader) return null;

  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const [writeKey] = decoded.split(':');
    return writeKey || null;
  }

  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7) || null;
  }

  return null;
}

export async function handler(
  event: APIGatewayRequestAuthorizerEventV2
): Promise<APIGatewaySimpleAuthorizerWithContextResult<{ sourceId: string }>> {
  const writeKey = extractWriteKey(event);

  if (!writeKey) {
    log.warn('Missing or invalid authorization header');
    return { isAuthorized: false, context: { sourceId: '' } };
  }

  const keyHash = hashWriteKey(writeKey);

  // Check cache
  const cached = cache.get(keyHash);
  if (cached && cached.expiresAt > Date.now()) {
    return { isAuthorized: true, context: { sourceId: cached.sourceId } };
  }

  // Query DynamoDB for SOURCE# records matching writeKeyHash
  try {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :keyHash AND gsi1sk = :meta',
        ExpressionAttributeValues: {
          ':keyHash': `WRITEKEY#${keyHash}`,
          ':meta': 'META',
        },
        Limit: 1,
      })
    );

    if (result.Items && result.Items.length > 0) {
      const sourceId = result.Items[0].id as string;
      cache.set(keyHash, { sourceId, expiresAt: Date.now() + CACHE_TTL_MS });
      log.info('Authorized', { sourceId });
      return { isAuthorized: true, context: { sourceId } };
    }
  } catch (err) {
    log.error('DynamoDB query failed', { error: String(err) });
  }

  log.warn('Unauthorized write key');
  return { isAuthorized: false, context: { sourceId: '' } };
}

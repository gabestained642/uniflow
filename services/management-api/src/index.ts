import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { logger } from '@uniflow/logger';
import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const PROFILES_TABLE = process.env.PROFILES_TABLE_NAME!;
const SOURCES_TABLE = process.env.SOURCES_TABLE_NAME!;
const DESTINATIONS_TABLE = process.env.DESTINATIONS_TABLE_NAME!;
const SEGMENTS_TABLE = process.env.SEGMENTS_TABLE_NAME!;
const SEGMENT_MEMBERS_TABLE = process.env.SEGMENT_MEMBERS_TABLE_NAME!;

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const SourceSchema = z.object({
  name: z.string().min(1),
  type: z.string().default('http'),
});

const DestinationSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['webhook', 's3-export']),
  config: z.record(z.unknown()),
  enabled: z.boolean().default(true),
});

const SegmentSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  rules: z.array(
    z.object({
      field: z.string(),
      operator: z.enum(['eq', 'neq', 'gt', 'lt', 'contains', 'exists']),
      value: z.unknown().optional(),
    })
  ),
});

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const log = logger.child({ path: event.requestContext.http.path });
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  try {
    // Sources
    if (path === '/api/sources' && method === 'GET') {
      return await listTable(SOURCES_TABLE);
    }
    if (path === '/api/sources' && method === 'POST') {
      return await createSource(event.body);
    }
    if (path.match(/^\/api\/sources\/[^/]+$/) && method === 'DELETE') {
      const id = path.split('/').pop()!;
      return await deleteEntity(SOURCES_TABLE, id);
    }

    // Destinations
    if (path === '/api/destinations' && method === 'GET') {
      return await listTable(DESTINATIONS_TABLE);
    }
    if (path === '/api/destinations' && method === 'POST') {
      return await createEntity(DESTINATIONS_TABLE, DestinationSchema, event.body);
    }
    if (path.match(/^\/api\/destinations\/[^/]+$/) && method === 'PUT') {
      const id = path.split('/').pop()!;
      return await updateEntity(DESTINATIONS_TABLE, DestinationSchema, id, event.body);
    }
    if (path.match(/^\/api\/destinations\/[^/]+$/) && method === 'DELETE') {
      const id = path.split('/').pop()!;
      return await deleteEntity(DESTINATIONS_TABLE, id);
    }

    // Segments
    if (path === '/api/segments' && method === 'GET') {
      return await listTable(SEGMENTS_TABLE);
    }
    if (path === '/api/segments' && method === 'POST') {
      return await createEntity(SEGMENTS_TABLE, SegmentSchema, event.body);
    }
    if (path.match(/^\/api\/segments\/[^/]+$/) && method === 'PUT') {
      const id = path.split('/').pop()!;
      return await updateEntity(SEGMENTS_TABLE, SegmentSchema, id, event.body);
    }
    if (path.match(/^\/api\/segments\/[^/]+\/members$/) && method === 'GET') {
      const id = path.split('/')[3];
      return await getSegmentMembers(id);
    }
    if (path.match(/^\/api\/segments\/[^/]+$/) && method === 'DELETE') {
      const id = path.split('/').pop()!;
      return await deleteEntity(SEGMENTS_TABLE, id);
    }

    // Profile explorer
    if (path.match(/^\/api\/profiles\/[^/]+$/) && method === 'GET') {
      const userId = path.split('/').pop()!;
      return await getProfile(userId);
    }

    return json(404, { error: 'Not found' });
  } catch (err) {
    log.error('Unhandled error', { error: String(err) });
    return json(500, { error: 'Internal server error' });
  }
}

async function listTable(tableName: string): Promise<APIGatewayProxyStructuredResultV2> {
  const result = await dynamo.send(
    new ScanCommand({ TableName: tableName })
  );
  return json(200, { items: result.Items ?? [] });
}

async function createSource(
  body: string | undefined
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!body) return json(400, { error: 'Missing body' });

  const parsed = SourceSchema.parse(JSON.parse(body));
  const id = randomUUID();
  const now = new Date().toISOString();

  const writeKey = `wk_${randomUUID().replace(/-/g, '')}`;
  const writeKeyHash = createHash('sha256').update(writeKey).digest('hex');

  await dynamo.send(
    new PutCommand({
      TableName: SOURCES_TABLE,
      Item: {
        id,
        ...parsed,
        writeKeyHash,
        createdAt: now,
        updatedAt: now,
      },
    })
  );

  return json(201, { id, ...parsed, writeKey });
}

async function createEntity(
  tableName: string,
  schema: z.ZodSchema,
  body: string | undefined
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!body) return json(400, { error: 'Missing body' });

  const parsed = schema.parse(JSON.parse(body));
  const id = randomUUID();
  const now = new Date().toISOString();

  await dynamo.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        id,
        ...parsed,
        createdAt: now,
        updatedAt: now,
      },
    })
  );

  return json(201, { id, ...parsed });
}

async function deleteEntity(
  tableName: string,
  id: string
): Promise<APIGatewayProxyStructuredResultV2> {
  await dynamo.send(
    new DeleteCommand({
      TableName: tableName,
      Key: { id },
    })
  );
  return json(200, { success: true });
}

async function updateEntity(
  tableName: string,
  schema: z.ZodSchema,
  id: string,
  body: string | undefined
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!body) return json(400, { error: 'Missing body' });

  const parsed = schema.parse(JSON.parse(body));
  const now = new Date().toISOString();

  const expressionParts: string[] = [];
  const expressionNames: Record<string, string> = {};
  const expressionValues: Record<string, unknown> = {};

  Object.entries(parsed).forEach(([key, value], index) => {
    const nameAlias = `#f${index}`;
    const valueAlias = `:v${index}`;
    expressionParts.push(`${nameAlias} = ${valueAlias}`);
    expressionNames[nameAlias] = key;
    expressionValues[valueAlias] = value;
  });

  expressionParts.push('#updatedAt = :updatedAt');
  expressionNames['#updatedAt'] = 'updatedAt';
  expressionValues[':updatedAt'] = now;

  const result = await dynamo.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { id },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
      ReturnValues: 'ALL_NEW',
    })
  );

  return json(200, result.Attributes);
}

async function getSegmentMembers(
  id: string
): Promise<APIGatewayProxyStructuredResultV2> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: SEGMENT_MEMBERS_TABLE,
      KeyConditionExpression: 'segmentId = :sid',
      ExpressionAttributeValues: {
        ':sid': id,
      },
    })
  );

  const members = (result.Items ?? []).map((item) => item.userId);
  return json(200, { members });
}

async function getProfile(
  userId: string
): Promise<APIGatewayProxyStructuredResultV2> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: PROFILES_TABLE,
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      Limit: 100,
    })
  );

  if (!result.Items || result.Items.length === 0) {
    return json(404, { error: 'Profile not found' });
  }

  const meta = result.Items.find((i) => i.sortKey === 'META');
  const events = result.Items.filter((i) => (i.sortKey as string).startsWith('EVENT#'));

  return json(200, { profile: meta, events });
}

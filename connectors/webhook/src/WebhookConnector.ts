import { z } from 'zod';
import { BaseConnector, type ConnectorMetadata } from '@uniflow/connector-sdk';
import type { ConnectorEvent, ConnectorResult } from '@uniflow/connector-sdk';

const WebhookConfigSchema = z.object({
  url: z.string().url(),
  secret: z.string().optional(),
  headers: z.record(z.string()).optional(),
  method: z.enum(['POST', 'PUT']).default('POST'),
  maxRetries: z.number().int().min(0).max(5).default(3),
});

type WebhookConfig = z.infer<typeof WebhookConfigSchema>;

export class WebhookConnector extends BaseConnector<WebhookConfig> {
  readonly metadata: ConnectorMetadata = {
    id: 'webhook',
    name: 'Webhook',
    description: 'Send events to any HTTP endpoint',
    configSchema: WebhookConfigSchema,
  };

  async handle(connectorEvent: ConnectorEvent, config: WebhookConfig): Promise<ConnectorResult> {
    const body = JSON.stringify({
      event: connectorEvent.event,
      userId: connectorEvent.userId,
      sentAt: new Date().toISOString(),
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'uniflow-webhook/0.1',
      ...config.headers,
    };

    if (config.secret) {
      // Simple HMAC signature for webhook verification
      const { createHmac } = await import('crypto');
      const signature = createHmac('sha256', config.secret).update(body).digest('hex');
      headers['X-Uniflow-Signature'] = `sha256=${signature}`;
    }

    let lastError: string | undefined;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        const response = await fetch(config.url, {
          method: config.method,
          headers,
          body,
        });

        if (response.ok) {
          return { success: true };
        }

        lastError = `HTTP ${response.status}: ${response.statusText}`;

        // Only retry on 5xx status codes
        if (response.status < 500) {
          return { success: false, error: lastError };
        }
      } catch (err) {
        // Network errors are retryable
        lastError = err instanceof Error ? err.message : String(err);
      }

      // Wait with exponential backoff before next attempt (skip delay after last attempt)
      if (attempt < config.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }

    return { success: false, error: lastError };
  }
}

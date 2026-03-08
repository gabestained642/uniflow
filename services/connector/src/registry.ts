import { BaseConnector } from '@uniflow/connector-sdk';
import { WebhookConnector } from '@uniflow/connector-webhook';
import { S3ExportConnector } from '@uniflow/connector-s3-export';

const connectors = new Map<string, BaseConnector>();

function register(connector: BaseConnector): void {
  connectors.set(connector.metadata.id, connector);
}

// Register built-in connectors
register(new WebhookConnector());
register(new S3ExportConnector());

export function getConnector(type: string): BaseConnector | undefined {
  return connectors.get(type);
}

export function listConnectors(): string[] {
  return Array.from(connectors.keys());
}

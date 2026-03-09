import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StorageConstruct } from '../constructs/StorageConstruct';
import { IngestionConstruct } from '../constructs/IngestionConstruct';
import { ProcessingConstruct } from '../constructs/ProcessingConstruct';
import { AudienceConstruct } from '../constructs/AudienceConstruct';
import { AdminConstruct } from '../constructs/AdminConstruct';
import { ActivationConstruct } from '../constructs/ActivationConstruct';

export interface UnifowStackProps extends cdk.StackProps {
  /** Admin email for Cognito user pool */
  adminEmail: string;
  /** S3/DynamoDB retention in days */
  retentionDays?: number;
  /** Connectors to enable */
  connectors?: string[];
}

export class UnifowStack extends cdk.Stack {
  public readonly storage: StorageConstruct;
  public readonly ingestion: IngestionConstruct;
  public readonly processing: ProcessingConstruct;
  public readonly audience: AudienceConstruct;
  public readonly admin: AdminConstruct;
  public readonly activation: ActivationConstruct;

  constructor(scope: Construct, id: string, props: UnifowStackProps) {
    super(scope, id, props);

    this.storage = new StorageConstruct(this, 'Storage', {
      retentionDays: props.retentionDays ?? 90,
    });

    this.ingestion = new IngestionConstruct(this, 'Ingestion', {
      eventStream: this.storage.eventStream,
      sourcesTable: this.storage.sourcesTable,
    });

    this.processing = new ProcessingConstruct(this, 'Processing', {
      eventStream: this.storage.eventStream,
      profilesTable: this.storage.profilesTable,
      identityTable: this.storage.identityTable,
    });

    this.audience = new AudienceConstruct(this, 'Audience', {
      segmentsTable: this.storage.segmentsTable,
      segmentMembersTable: this.storage.segmentMembersTable,
      rawBucket: this.storage.rawBucket,
      processedBucket: this.storage.processedBucket,
      glueDatabase: this.storage.glueDatabase,
    });

    this.admin = new AdminConstruct(this, 'Admin', {
      adminEmail: props.adminEmail,
      profilesTable: this.storage.profilesTable,
      sourcesTable: this.storage.sourcesTable,
      destinationsTable: this.storage.destinationsTable,
      segmentsTable: this.storage.segmentsTable,
      segmentMembersTable: this.storage.segmentMembersTable,
    });

    this.activation = new ActivationConstruct(this, 'Activation', {
      destinationQueue: this.processing.destinationQueue,
      destinationsTable: this.storage.destinationsTable,
    });

    // Outputs
    new cdk.CfnOutput(this, 'IngestEndpoint', {
      value: this.ingestion.apiEndpoint,
      description: 'HTTP endpoint for sending events',
    });

    new cdk.CfnOutput(this, 'AdminUrl', {
      value: this.admin.cloudFrontUrl,
      description: 'Admin dashboard URL',
    });
  }
}

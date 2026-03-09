import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface StorageConstructProps {
  retentionDays: number;
}

export class StorageConstruct extends Construct {
  public readonly profilesTable: dynamodb.Table;
  public readonly identityTable: dynamodb.Table;
  public readonly sourcesTable: dynamodb.Table;
  public readonly destinationsTable: dynamodb.Table;
  public readonly segmentsTable: dynamodb.Table;
  public readonly segmentMembersTable: dynamodb.Table;
  public readonly eventStream: kinesis.Stream;
  public readonly rawBucket: s3.Bucket;
  public readonly processedBucket: s3.Bucket;
  public readonly glueDatabase: glue.CfnDatabase;
  public readonly glueTable: glue.CfnTable;
  public readonly segmentMembersGlueTable: glue.CfnTable;
  public readonly encryptionKey: kms.Key;

  constructor(scope: Construct, id: string, props: StorageConstructProps) {
    super(scope, id);

    // Profiles table — stores profile metadata and event history
    this.profilesTable = new dynamodb.Table(this, 'ProfilesTable', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sortKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // Identity table — maps anonymousId → userId
    this.identityTable = new dynamodb.Table(this, 'IdentityTable', {
      partitionKey: { name: 'anonymousId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Sources table — write-key authenticated event sources
    this.sourcesTable = new dynamodb.Table(this, 'SourcesTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.sourcesTable.addGlobalSecondaryIndex({
      indexName: 'writeKeyHashIndex',
      partitionKey: { name: 'writeKeyHash', type: dynamodb.AttributeType.STRING },
    });

    // Destinations table — connector configurations
    this.destinationsTable = new dynamodb.Table(this, 'DestinationsTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Segments table — segment definitions
    this.segmentsTable = new dynamodb.Table(this, 'SegmentsTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Segment members table — membership records from audience builder
    this.segmentMembersTable = new dynamodb.Table(this, 'SegmentMembersTable', {
      partitionKey: { name: 'segmentId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Kinesis Data Stream (7-day retention)
    this.eventStream = new kinesis.Stream(this, 'EventStream', {
      retentionPeriod: cdk.Duration.days(7),
      shardCount: 2,
      encryption: kinesis.StreamEncryption.MANAGED,
    });

    // S3 raw bucket (immutable Parquet archive)
    this.rawBucket = new s3.Bucket(this, 'RawBucket', {
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(props.retentionDays),
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // S3 processed bucket (for Athena queries)
    this.processedBucket = new s3.Bucket(this, 'ProcessedBucket', {
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Kinesis Firehose → S3 (raw events in Parquet-like JSON)
    const firehoseRole = new iam.Role(this, 'FirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });
    this.rawBucket.grantWrite(firehoseRole);
    this.eventStream.grantRead(firehoseRole);

    new firehose.CfnDeliveryStream(this, 'EventFirehose', {
      kinesisStreamSourceConfiguration: {
        kinesisStreamArn: this.eventStream.streamArn,
        roleArn: firehoseRole.roleArn,
      },
      s3DestinationConfiguration: {
        bucketArn: this.rawBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        prefix: 'raw/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
        errorOutputPrefix: 'errors/',
        bufferingHints: {
          intervalInSeconds: 60,
          sizeInMBs: 64,
        },
        compressionFormat: 'GZIP',
      },
    });

    // -------------------------------------------------------
    // Glue Database & Table — enables Athena queries over raw events
    // -------------------------------------------------------
    this.glueDatabase = new glue.CfnDatabase(this, 'GlueDatabase', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseInput: {
        name: 'uniflow',
        description: 'Uniflow CDP raw and processed event data',
      },
    });

    this.glueTable = new glue.CfnTable(this, 'RawEventsTable', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseName: 'uniflow',
      tableInput: {
        name: 'uniflow_raw_events',
        description: 'Raw CDP events delivered by Firehose (JSON lines, GZIP)',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          'classification': 'json',
          'compressionType': 'gzip',
          'typeOfData': 'file',
        },
        storageDescriptor: {
          location: `s3://${this.rawBucket.bucketName}/raw/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          compressed: true,
          serdeInfo: {
            serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
            parameters: {
              'ignore.malformed.json': 'true',
            },
          },
          columns: [
            { name: 'event_id', type: 'string' },
            { name: 'event_type', type: 'string' },
            { name: 'timestamp', type: 'string' },
            { name: 'user_id', type: 'string' },
            { name: 'anonymous_id', type: 'string' },
            { name: 'source_id', type: 'string' },
            { name: 'properties', type: 'string' },
            { name: 'context', type: 'string' },
          ],
        },
        partitionKeys: [
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
        ],
      },
    });
    this.glueTable.addDependency(this.glueDatabase);

    // Glue table for segment membership results (Parquet on S3)
    this.segmentMembersGlueTable = new glue.CfnTable(this, 'SegmentMembersGlueTable', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseName: 'uniflow',
      tableInput: {
        name: 'uniflow_segment_members',
        description: 'Segment membership computed by audience builder (Parquet)',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          'classification': 'parquet',
          'typeOfData': 'file',
        },
        storageDescriptor: {
          location: `s3://${this.processedBucket.bucketName}/segments/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          compressed: false,
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
          },
          columns: [
            { name: 'segment_id', type: 'string' },
            { name: 'user_id', type: 'string' },
            { name: 'added_at', type: 'string' },
          ],
        },
        partitionKeys: [
          { name: 'segment_id', type: 'string' },
        ],
      },
    });
    this.segmentMembersGlueTable.addDependency(this.glueDatabase);

    // -------------------------------------------------------
    // KMS key — encrypts Secrets Manager destination credentials
    // -------------------------------------------------------
    this.encryptionKey = new kms.Key(this, 'SecretsEncryptionKey', {
      description: 'Encrypts Uniflow destination credentials in Secrets Manager',
      enableKeyRotation: true,
      alias: 'uniflow/secrets',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // NOTE: Individual secrets for each destination connector are created
    // dynamically by the Management API at runtime using this KMS key.
    // See the Management API Lambda for the Secrets Manager create/update logic.
  }
}

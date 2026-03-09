import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as path from 'path';
import { Construct } from 'constructs';

export interface AudienceConstructProps {
  segmentsTable: dynamodb.Table;
  segmentMembersTable: dynamodb.Table;
  rawBucket: s3.Bucket;
  processedBucket: s3.Bucket;
  glueDatabase: glue.CfnDatabase;
}

export class AudienceConstruct extends Construct {
  constructor(scope: Construct, id: string, props: AudienceConstructProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // Glue IAM Role
    const glueRole = new iam.Role(this, 'GlueJobRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
    });

    props.rawBucket.grantRead(glueRole);
    props.processedBucket.grantReadWrite(glueRole);
    props.segmentsTable.grantReadData(glueRole);
    props.segmentMembersTable.grantReadWriteData(glueRole);

    // Deploy PySpark script to S3
    new s3deploy.BucketDeployment(this, 'DeployGlueScript', {
      sources: [
        s3deploy.Source.asset(
          path.join(__dirname, '../../../services/audience-builder/glue')
        ),
      ],
      destinationBucket: props.processedBucket,
      destinationKeyPrefix: 'glue-scripts',
      memoryLimit: 256,
    });

    // Glue Job
    new glue.CfnJob(this, 'SegmentEvaluatorJob', {
      name: 'uniflow-segment-evaluator',
      role: glueRole.roleArn,
      command: {
        name: 'glueetl',
        scriptLocation: `s3://${props.processedBucket.bucketName}/glue-scripts/segment_evaluator.py`,
        pythonVersion: '3',
      },
      glueVersion: '4.0',
      workerType: 'G.1X',
      numberOfWorkers: 2,
      defaultArguments: {
        '--SEGMENTS_TABLE_NAME': props.segmentsTable.tableName,
        '--SEGMENT_MEMBERS_TABLE_NAME': props.segmentMembersTable.tableName,
        '--RAW_BUCKET_NAME': props.rawBucket.bucketName,
        '--PROCESSED_BUCKET_NAME': props.processedBucket.bucketName,
        '--GLUE_DATABASE': 'uniflow',
        '--job-bookmark-option': 'job-bookmark-enable',
        '--enable-metrics': 'true',
      },
    });

    // EventBridge Scheduler role
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });

    schedulerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['glue:StartJobRun'],
        resources: [
          cdk.Arn.format(
            { service: 'glue', resource: 'job', resourceName: 'uniflow-segment-evaluator' },
            stack
          ),
        ],
      })
    );

    // Hourly audience evaluation schedule
    new scheduler.CfnSchedule(this, 'AudienceSchedule', {
      scheduleExpression: 'rate(1 hour)',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: cdk.Arn.format(
          { service: 'glue', resource: 'job', resourceName: 'uniflow-segment-evaluator' },
          stack
        ),
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ JobName: 'uniflow-segment-evaluator' }),
      },
    });
  }
}

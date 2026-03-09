import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { Construct } from 'constructs';

export interface AdminConstructProps {
  adminEmail: string;
  profilesTable: dynamodb.Table;
  sourcesTable: dynamodb.Table;
  destinationsTable: dynamodb.Table;
  segmentsTable: dynamodb.Table;
  segmentMembersTable: dynamodb.Table;
}

export class AdminConstruct extends Construct {
  public readonly cloudFrontUrl: string;
  public readonly managementApiEndpoint: string;

  constructor(scope: Construct, id: string, props: AdminConstructProps) {
    super(scope, id);

    // Cognito User Pool
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolClient = userPool.addClient('AdminClient', {
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
    });

    // Pre-create admin user via CfnUserPoolUser
    new cognito.CfnUserPoolUser(this, 'AdminUser', {
      userPoolId: userPool.userPoolId,
      username: props.adminEmail,
      userAttributes: [
        { name: 'email', value: props.adminEmail },
        { name: 'email_verified', value: 'true' },
      ],
      desiredDeliveryMediums: ['EMAIL'],
    });

    // Management API Lambda
    const managementFn = new lambda.Function(this, 'ManagementFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../../../services/management-api/dist')
      ),
      environment: {
        PROFILES_TABLE_NAME: props.profilesTable.tableName,
        SOURCES_TABLE_NAME: props.sourcesTable.tableName,
        DESTINATIONS_TABLE_NAME: props.destinationsTable.tableName,
        SEGMENTS_TABLE_NAME: props.segmentsTable.tableName,
        SEGMENT_MEMBERS_TABLE_NAME: props.segmentMembersTable.tableName,
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        LOG_LEVEL: 'info',
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });

    props.profilesTable.grantReadWriteData(managementFn);
    props.sourcesTable.grantReadWriteData(managementFn);
    props.destinationsTable.grantReadWriteData(managementFn);
    props.segmentsTable.grantReadWriteData(managementFn);
    props.segmentMembersTable.grantReadWriteData(managementFn);

    // HTTP API for management
    const api = new apigwv2.HttpApi(this, 'ManagementApi', {
      apiName: 'uniflow-management',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const mgmtIntegration = new integrations.HttpLambdaIntegration(
      'ManagementIntegration',
      managementFn
    );

    const region = cdk.Stack.of(this).region;
    const issuerUrl = `https://cognito-idp.${region}.amazonaws.com/${userPool.userPoolId}`;

    const jwtAuthorizer = new HttpJwtAuthorizer('CognitoAuthorizer', issuerUrl, {
      jwtAudience: [userPoolClient.userPoolClientId],
    });

    api.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: mgmtIntegration,
      authorizer: jwtAuthorizer,
    });

    this.managementApiEndpoint = api.apiEndpoint;

    // S3 bucket for Next.js static export
    const uiBucket = new s3.Bucket(this, 'UiBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'UiDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(uiBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    this.cloudFrontUrl = `https://${distribution.distributionDomainName}`;

    // Handle missing ui/out/ at synth time
    const uiAssetPath = path.join(__dirname, '../../../ui/out');
    if (!existsSync(uiAssetPath)) {
      mkdirSync(uiAssetPath, { recursive: true });
      writeFileSync(path.join(uiAssetPath, 'index.html'),
        '<html><body>UI not built yet. Run: pnpm --filter @uniflow/ui build</body></html>');
    }

    new s3deploy.BucketDeployment(this, 'DeployUi', {
      sources: [s3deploy.Source.asset(uiAssetPath)],
      destinationBucket: uiBucket,
      distribution,
      distributionPaths: ['/*'],
      memoryLimit: 256,
    });

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'ManagementApiEndpoint', { value: this.managementApiEndpoint });
  }
}

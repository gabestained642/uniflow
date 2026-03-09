#!/bin/bash
# NOTE: Make this script executable before use: chmod +x docker/localstack/init/01_setup.sh
set -e

echo "==> Initializing LocalStack resources for Uniflow CDP..."

# DynamoDB Tables (multi-table design)
awslocal dynamodb create-table \
  --table-name uniflow-profiles \
  --attribute-definitions \
    AttributeName=userId,AttributeType=S \
    AttributeName=sortKey,AttributeType=S \
  --key-schema \
    AttributeName=userId,KeyType=HASH \
    AttributeName=sortKey,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1

echo "==> Created DynamoDB table: uniflow-profiles"

awslocal dynamodb create-table \
  --table-name uniflow-identity \
  --attribute-definitions \
    AttributeName=anonymousId,AttributeType=S \
  --key-schema \
    AttributeName=anonymousId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1

echo "==> Created DynamoDB table: uniflow-identity"

awslocal dynamodb create-table \
  --table-name uniflow-sources \
  --attribute-definitions \
    AttributeName=id,AttributeType=S \
    AttributeName=writeKeyHash,AttributeType=S \
  --key-schema \
    AttributeName=id,KeyType=HASH \
  --global-secondary-indexes '[
    {
      "IndexName": "writeKeyHashIndex",
      "KeySchema": [
        {"AttributeName":"writeKeyHash","KeyType":"HASH"}
      ],
      "Projection": {"ProjectionType":"ALL"}
    }
  ]' \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1

echo "==> Created DynamoDB table: uniflow-sources"

awslocal dynamodb create-table \
  --table-name uniflow-destinations \
  --attribute-definitions \
    AttributeName=id,AttributeType=S \
  --key-schema \
    AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1

echo "==> Created DynamoDB table: uniflow-destinations"

awslocal dynamodb create-table \
  --table-name uniflow-segments \
  --attribute-definitions \
    AttributeName=id,AttributeType=S \
  --key-schema \
    AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1

echo "==> Created DynamoDB table: uniflow-segments"

awslocal dynamodb create-table \
  --table-name uniflow-segment-members \
  --attribute-definitions \
    AttributeName=segmentId,AttributeType=S \
    AttributeName=userId,AttributeType=S \
  --key-schema \
    AttributeName=segmentId,KeyType=HASH \
    AttributeName=userId,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1

echo "==> Created DynamoDB table: uniflow-segment-members"

# S3 Buckets
awslocal s3 mb s3://uniflow-raw --region us-east-1
awslocal s3 mb s3://uniflow-processed --region us-east-1

echo "==> Created S3 buckets: uniflow-raw, uniflow-processed"

# Kinesis Stream
awslocal kinesis create-stream \
  --stream-name uniflow-events \
  --shard-count 1 \
  --region us-east-1

echo "==> Created Kinesis stream: uniflow-events"

# SQS Queue
awslocal sqs create-queue \
  --queue-name uniflow-destinations \
  --region us-east-1

awslocal sqs create-queue \
  --queue-name uniflow-dlq \
  --region us-east-1

echo "==> Created SQS queues"

echo "==> LocalStack initialization complete!"

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Breaking: Multi-table DynamoDB** — Replaced single-table design (`profileTable` with PK/SK prefix conventions) with 6 dedicated tables: `profilesTable`, `identityTable`, `sourcesTable`, `destinationsTable`, `segmentsTable`, `segmentMembersTable`. Each service now receives only the tables it needs. ([#infra](infra/src/constructs/StorageConstruct.ts))
- **Breaking: Audience builder migrated from ECS Fargate to AWS Glue PySpark** — Removes VPC, NAT gateway, ECS cluster, and Fargate task definition. Segment evaluation now runs as a serverless Glue 4.0 job with PySpark, writing results to both S3 (Parquet) and DynamoDB (diff-based updates). (~$30–45/month infrastructure savings) ([#infra](infra/src/constructs/AudienceConstruct.ts))
- **Breaking: Environment variable renames** — All services now use table-specific env vars (`SOURCES_TABLE_NAME`, `PROFILES_TABLE_NAME`, `IDENTITY_TABLE_NAME`, `DESTINATIONS_TABLE_NAME`, `SEGMENTS_TABLE_NAME`, `SEGMENT_MEMBERS_TABLE_NAME`) instead of the single `PROFILE_TABLE_NAME`.

### Added

- `writeKeyHashIndex` GSI on sources table for write-key authentication lookups
- `segmentMembersTable` for clean separation of segment membership from segment definitions
- `uniflow_segment_members` Glue catalog table for Athena queries over segment membership Parquet data
- `services/audience-builder/glue/segment_evaluator.py` — PySpark script for segment evaluation with diff-based DynamoDB updates
- Segment membership results written to S3 as Parquet at `s3://{processed_bucket}/segments/{segment_id}/members.parquet`

### Removed

- Single-table DynamoDB design (PK/SK prefix conventions: `PROFILE#`, `SOURCE#`, `DEST#`, `SEGMENT#`, `ANON#`)
- `gsi1` GSI with `gsi1pk`/`gsi1sk` synthetic attributes
- VPC and NAT gateway from AudienceConstruct
- ECS Cluster and Fargate task definition
- Container image build/push for audience-builder
- Athena polling loop in audience-builder (replaced by Spark direct S3 reads)

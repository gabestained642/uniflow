"""
Glue PySpark job: Evaluates segment definitions against raw events,
writes membership to S3 (Parquet) and DynamoDB (diff-based update).
"""

import sys
import boto3
from datetime import datetime

from awsglue.utils import getResolvedOptions
from awsglue.context import GlueContext
from awsglue.job import Job
from pyspark.context import SparkContext

# ── Bootstrap ──────────────────────────────────────────────────────
args = getResolvedOptions(sys.argv, [
    "JOB_NAME",
    "SEGMENTS_TABLE_NAME",
    "SEGMENT_MEMBERS_TABLE_NAME",
    "RAW_BUCKET_NAME",
    "PROCESSED_BUCKET_NAME",
    "GLUE_DATABASE",
])

sc = SparkContext()
glue_ctx = GlueContext(sc)
spark = glue_ctx.spark_session
job = Job(glue_ctx)
job.init(args["JOB_NAME"], args)

dynamodb = boto3.resource("dynamodb")
segments_table = dynamodb.Table(args["SEGMENTS_TABLE_NAME"])
members_table = dynamodb.Table(args["SEGMENT_MEMBERS_TABLE_NAME"])

PROCESSED_BUCKET = args["PROCESSED_BUCKET_NAME"]
GLUE_DATABASE = args["GLUE_DATABASE"]

# ── Operator mapping ──────────────────────────────────────────────

OPERATOR_SQL = {
    "eq": "{field} = '{value}'",
    "neq": "{field} != '{value}'",
    "gt": "{field} > '{value}'",
    "lt": "{field} < '{value}'",
    "contains": "{field} LIKE '%{value}%'",
    "exists": "{field} IS NOT NULL",
}


def rules_to_sql(rules):
    """Translate segment rules to a SQL WHERE clause."""
    clauses = []
    for rule in rules:
        op = rule.get("operator", "eq")
        template = OPERATOR_SQL.get(op)
        if template is None:
            continue
        clauses.append(
            template.format(field=rule["field"], value=rule.get("value", ""))
        )
    return " AND ".join(clauses) if clauses else "1=1"


# ── Load raw events via Glue catalog ──────────────────────────────
events_df = glue_ctx.create_dynamic_frame.from_catalog(
    database=GLUE_DATABASE,
    table_name="uniflow_raw_events",
).toDF()

events_df.createOrReplaceTempView("raw_events")

# ── Fetch segment definitions ─────────────────────────────────────
scan_resp = segments_table.scan()
segments = scan_resp.get("Items", [])

now = datetime.utcnow().isoformat() + "Z"

for segment in segments:
    segment_id = segment["id"]
    rules = segment.get("rules", [])
    where_clause = rules_to_sql(rules)

    query = f"""
        SELECT DISTINCT user_id
        FROM raw_events
        WHERE user_id IS NOT NULL AND ({where_clause})
    """

    try:
        new_members_df = spark.sql(query)
    except Exception as e:
        print(f"Segment {segment_id} query failed: {e}")
        continue

    new_member_ids = {row.user_id for row in new_members_df.collect()}

    # ── Write Parquet to S3 ───────────────────────────────────────
    if new_member_ids:
        output_path = f"s3://{PROCESSED_BUCKET}/segments/{segment_id}/members.parquet"
        new_members_df.write.mode("overwrite").parquet(output_path)

    # ── Diff-based DynamoDB update ────────────────────────────────
    existing_resp = members_table.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key("segmentId").eq(segment_id)
    )
    existing_ids = {item["userId"] for item in existing_resp.get("Items", [])}

    to_add = new_member_ids - existing_ids
    to_remove = existing_ids - new_member_ids

    # Batch write additions
    with members_table.batch_writer() as batch:
        for uid in to_add:
            batch.put_item(Item={
                "segmentId": segment_id,
                "userId": uid,
                "addedAt": now,
            })

    # Batch delete removals
    with members_table.batch_writer() as batch:
        for uid in to_remove:
            batch.delete_item(Key={
                "segmentId": segment_id,
                "userId": uid,
            })

    print(f"Segment {segment_id}: {len(to_add)} added, {len(to_remove)} removed, {len(new_member_ids)} total")

job.commit()

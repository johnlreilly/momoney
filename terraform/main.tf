terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ── DynamoDB ─────────────────────────────────────────────────────────────────

resource "aws_dynamodb_table" "momoney" {
  name         = "momoney"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # GSI so the Lambda can find all users via their SETTINGS item
  global_secondary_index {
    name            = "sk-index"
    hash_key        = "sk"
    projection_type = "KEYS_ONLY"
  }

  tags = {
    Project = "momoney"
  }
}

# ── IAM role for Lambda ───────────────────────────────────────────────────────

resource "aws_iam_role" "cron" {
  name = "momoney-cron"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "cron_dynamo" {
  name = "momoney-cron-dynamo"
  role = aws_iam_role.cron.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]
        Resource = [aws_dynamodb_table.momoney.arn, "${aws_dynamodb_table.momoney.arn}/index/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      }
    ]
  })
}

# ── Lambda ────────────────────────────────────────────────────────────────────

data "archive_file" "cron" {
  type        = "zip"
  source_file = "${path.module}/../lambda/cron.mjs"
  output_path = "${path.module}/lambda.zip"
}

resource "aws_lambda_function" "cron" {
  filename         = data.archive_file.cron.output_path
  source_code_hash = data.archive_file.cron.output_base64sha256
  function_name    = "momoney-cron"
  role             = aws_iam_role.cron.arn
  handler          = "cron.handler"

  runtime          = "nodejs22.x"
  timeout          = 30

  environment {
    variables = {
      DYNAMODB_TABLE        = aws_dynamodb_table.momoney.name
      GEMINI_API_KEY        = var.gemini_api_key
      GEMINI_MODEL          = var.gemini_model
      ALPHA_VANTAGE_API_KEY = var.alpha_vantage_api_key
    }
  }

  tags = {
    Project = "momoney"
  }
}

# ── EventBridge schedules (10 min before each phase, Mon–Fri ET) ─────────────
# All times in UTC. Assumes EDT (UTC-4, Apr–Oct). Adjust +1h in Nov–Mar.

locals {
  cron_schedules = {
    pre-market    = "cron(50 11 ? * MON-FRI *)"   # 7:50 AM ET
    opening-drive = "cron(20 13 ? * MON-FRI *)"   # 9:20 AM ET
    midday-fade   = "cron(20 14 ? * MON-FRI *)"   # 10:20 AM ET
    power-hour    = "cron(50 18 ? * MON-FRI *)"   # 2:50 PM ET
  }
}

resource "aws_cloudwatch_event_rule" "cron" {
  for_each            = local.cron_schedules
  name                = "momoney-${each.key}"
  schedule_expression = each.value
  state               = "ENABLED"
}

resource "aws_cloudwatch_event_target" "cron" {
  for_each  = local.cron_schedules
  rule      = aws_cloudwatch_event_rule.cron[each.key].name
  target_id = "momoney-cron-${each.key}"
  arn       = aws_lambda_function.cron.arn
}

resource "aws_lambda_permission" "eventbridge" {
  for_each      = local.cron_schedules
  statement_id  = "AllowEventBridge-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cron.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.cron[each.key].arn
}

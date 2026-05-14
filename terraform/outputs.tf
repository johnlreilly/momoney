output "dynamodb_table_name" {
  value = aws_dynamodb_table.momoney.name
}

output "dynamodb_table_arn" {
  value = aws_dynamodb_table.momoney.arn
}

output "lambda_function_name" {
  value = aws_lambda_function.cron.function_name
}

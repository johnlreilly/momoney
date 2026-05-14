variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "gemini_api_key" {
  description = "Gemini API key for AI session generation"
  type        = string
  sensitive   = true
}

variable "alpha_vantage_api_key" {
  description = "Alpha Vantage API key for market data"
  type        = string
  sensitive   = true
}

variable "gemini_model" {
  description = "Gemini model ID"
  type        = string
  default     = "gemini-2.0-flash"
}

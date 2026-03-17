# =============================================================================
# Backend: API de tareas (DynamoDB + Lambda + API Gateway HTTP + Cognito)
# Despliegue: terraform init && terraform apply
# =============================================================================

terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------
variable "admin_email" {
  description = "Email del usuario administrador (root)"
  type        = string
}

variable "admin_temp_password" {
  description = "Contraseña temporal del admin (se cambia en el primer login)"
  type        = string
  sensitive   = true
  default     = "TempPass123!"
}

# ---------------------------------------------------------------------------
# DynamoDB
# ---------------------------------------------------------------------------
resource "aws_dynamodb_table" "tareas" {
  name         = "tareas-hola-fullstack"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
}

# ---------------------------------------------------------------------------
# Cognito
# ---------------------------------------------------------------------------
resource "aws_cognito_user_pool" "main" {
  name = "hola-fullstack-pool"

  username_attributes = ["email"]

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = true
  }

  auto_verified_attributes = ["email"]

  schema {
    attribute_data_type      = "String"
    name                     = "email"
    required                 = true
    mutable                  = true
    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }
}

resource "aws_cognito_user_pool_client" "frontend" {
  name         = "hola-fullstack-frontend"
  user_pool_id = aws_cognito_user_pool.main.id

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  generate_secret = false
}

# Crear usuario admin y establecer contraseña permanente
resource "null_resource" "admin_user" {
  triggers = {
    user_pool_id = aws_cognito_user_pool.main.id
    admin_email  = var.admin_email
  }

  provisioner "local-exec" {
    command = "aws cognito-idp admin-create-user --user-pool-id ${aws_cognito_user_pool.main.id} --username ${var.admin_email} --user-attributes Name=email,Value=${var.admin_email} Name=email_verified,Value=true --temporary-password ${var.admin_temp_password} --message-action SUPPRESS --region us-east-1 || cd ."
  }

  provisioner "local-exec" {
    command = "aws cognito-idp admin-set-user-password --user-pool-id ${aws_cognito_user_pool.main.id} --username ${var.admin_email} --password ${var.admin_temp_password} --permanent --region us-east-1"
  }
}

# ---------------------------------------------------------------------------
# Lambda
# ---------------------------------------------------------------------------
resource "aws_iam_role" "lambda_tasks" {
  name = "lambda-tasks-api-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "lambda_tasks_dynamodb" {
  name = "dynamodb"
  role = aws_iam_role.lambda_tasks.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
        Resource = [aws_dynamodb_table.tareas.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      }
    ]
  })
}

resource "null_resource" "lambda_npm_install" {
  triggers = {
    package_json = filemd5("${path.module}/lambda/tasks-api/package.json")
    index        = filemd5("${path.module}/lambda/tasks-api/index.mjs")
  }
  provisioner "local-exec" {
    command = "cd ${path.module}/lambda/tasks-api && npm install"
  }
}

data "archive_file" "lambda_tasks" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/tasks-api"
  output_path = "${path.module}/lambda/tasks-api.zip"
  depends_on  = [null_resource.lambda_npm_install]
}

resource "aws_lambda_function" "tasks_api" {
  filename         = data.archive_file.lambda_tasks.output_path
  function_name    = "tasks-api-hola-fullstack"
  role             = aws_iam_role.lambda_tasks.arn
  handler          = "index.handler"
  source_code_hash = data.archive_file.lambda_tasks.output_base64sha256
  runtime          = "nodejs20.x"

  environment {
    variables = { TABLE_NAME = aws_dynamodb_table.tareas.name }
  }
}

# ---------------------------------------------------------------------------
# API Gateway HTTP API
# ---------------------------------------------------------------------------
resource "aws_apigatewayv2_api" "tasks" {
  name          = "tasks-api-hola-fullstack"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["Content-Type", "Authorization"]
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.tasks.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.tasks_api.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

# JWT Authorizer (Cognito)
resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.tasks.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "cognito-jwt"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.frontend.id]
    issuer   = "https://cognito-idp.us-east-1.amazonaws.com/${aws_cognito_user_pool.main.id}"
  }
}

# --- Rutas públicas (sin auth) ---
resource "aws_apigatewayv2_route" "get_tasks" {
  api_id    = aws_apigatewayv2_api.tasks.id
  route_key = "GET /tasks"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "get_task" {
  api_id    = aws_apigatewayv2_api.tasks.id
  route_key = "GET /tasks/{id}"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

# --- Rutas protegidas (JWT auth) ---
resource "aws_apigatewayv2_route" "post_tasks" {
  api_id             = aws_apigatewayv2_api.tasks.id
  route_key          = "POST /tasks"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "put_task" {
  api_id             = aws_apigatewayv2_api.tasks.id
  route_key          = "PUT /tasks/{id}"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "delete_task" {
  api_id             = aws_apigatewayv2_api.tasks.id
  route_key          = "DELETE /tasks/{id}"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

# Deployment
resource "aws_apigatewayv2_deployment" "tasks" {
  api_id = aws_apigatewayv2_api.tasks.id
  depends_on = [
    aws_apigatewayv2_route.get_tasks,
    aws_apigatewayv2_route.get_task,
    aws_apigatewayv2_route.post_tasks,
    aws_apigatewayv2_route.put_task,
    aws_apigatewayv2_route.delete_task,
  ]
}

resource "aws_apigatewayv2_stage" "default" {
  api_id        = aws_apigatewayv2_api.tasks.id
  name          = "$default"
  deployment_id = aws_apigatewayv2_deployment.tasks.id
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.tasks_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.tasks.execution_arn}/*/*"
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------
output "api_url" {
  description = "URL base de la API de tareas"
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "cognito_user_pool_id" {
  description = "ID del User Pool de Cognito"
  value       = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  description = "ID del cliente de Cognito para el frontend"
  value       = aws_cognito_user_pool_client.frontend.id
}

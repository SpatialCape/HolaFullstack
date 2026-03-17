# =============================================================================
# Frontend: Amplify (build y hosting del React desde Git)
# Requiere backend desplegado (variables api_url, cognito_user_pool_id, cognito_client_id).
# Despliegue: terraform init && terraform apply
# El código React se recompila en cada git push a la rama configurada.
# =============================================================================

terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------
variable "api_url" {
  description = "URL base de la API de tareas (backend: terraform output -raw api_url)"
  type        = string
}

variable "github_token" {
  description = "Token de GitHub para que Amplify clone el repo"
  type        = string
  sensitive   = true
}

variable "repository" {
  description = "URL del repositorio Git"
  type        = string
  default     = "https://github.com/SpatialCape/HolaFullstack"
}

variable "branch_name" {
  description = "Rama que Amplify vigila"
  type        = string
  default     = "main"
}

variable "app_root" {
  description = "Carpeta del frontend dentro del repo (vacío si la raíz es el frontend)"
  type        = string
  default     = "frontend"
}

variable "cognito_user_pool_id" {
  description = "ID del User Pool de Cognito (backend: terraform output -raw cognito_user_pool_id)"
  type        = string
}

variable "cognito_client_id" {
  description = "ID del cliente de Cognito (backend: terraform output -raw cognito_client_id)"
  type        = string
}

# ---------------------------------------------------------------------------
# Build spec
# ---------------------------------------------------------------------------
locals {
  build_spec_monorepo = <<-EOT
version: 1
applications:
  - appRoot: ${var.app_root}
    frontend:
      phases:
        preBuild:
          commands:
            - npm ci
        build:
          commands:
            - npm run build
      artifacts:
        baseDirectory: dist
        files:
          - '**/*'
      cache:
        paths:
          - node_modules/**/*
EOT
  build_spec_simple = <<-EOT
version: 1
frontend:
  phases:
    preBuild:
      commands:
        - npm ci
    build:
      commands:
        - npm run build
  artifacts:
    baseDirectory: dist
    files:
      - '**/*'
  cache:
    paths:
      - node_modules/**/*
EOT
  build_spec = var.app_root != "" ? local.build_spec_monorepo : local.build_spec_simple
}

# ---------------------------------------------------------------------------
# Amplify
# ---------------------------------------------------------------------------
resource "aws_amplify_app" "hola_fullstack" {
  name        = "hola-fullstack"
  repository  = var.repository
  oauth_token = var.github_token

  environment_variables = merge(
    {
      VITE_API_URL              = var.api_url
      VITE_COGNITO_USER_POOL_ID = var.cognito_user_pool_id
      VITE_COGNITO_CLIENT_ID    = var.cognito_client_id
    },
    var.app_root != "" ? { AMPLIFY_MONOREPO_APP_ROOT = var.app_root } : {}
  )

  build_spec = local.build_spec

  custom_rule {
    source = "</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|ttf|map|json)$)([^.]+$)/>"
    target = "/index.html"
    status = "200"
  }
}

resource "aws_amplify_branch" "main" {
  app_id      = aws_amplify_app.hola_fullstack.id
  branch_name = var.branch_name
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------
output "amplify_app_id" {
  description = "ID de la app Amplify"
  value       = aws_amplify_app.hola_fullstack.id
}

output "amplify_default_domain" {
  description = "URL por defecto de la app"
  value       = "https://${var.branch_name}.${aws_amplify_app.hola_fullstack.default_domain}"
}

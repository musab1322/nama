# Saudi cell base (FR-017, ADR-002). NOT APPLIED. Cloud-agnostic on purpose: the
# Kubernetes cluster itself is created with the chosen Saudi provider's own module
# (Google Cloud Dammam, Oracle Jeddah/Riyadh, STC Cloud...) when the first paid
# request arrives; this layer installs what the cell needs on top of any cluster.
terraform {
  required_version = ">= 1.6"
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.31" }
    helm       = { source = "hashicorp/helm", version = "~> 2.14" }
  }
}

provider "kubernetes" {
  config_path    = var.kubeconfig_path
  config_context = var.kube_context
}

provider "helm" {
  kubernetes {
    config_path    = var.kubeconfig_path
    config_context = var.kube_context
  }
}

locals {
  labels = { "banna.sa/cell" = "true", "banna.sa/region" = var.region_label }
}

resource "kubernetes_namespace" "system" {
  metadata {
    name   = "banna-cell-system"
    labels = local.labels
  }
}

# Postgres for every app: one cluster (database) per app, managed by CloudNativePG,
# with backups to in-Kingdom object storage.
resource "helm_release" "cnpg" {
  name             = "cnpg"
  repository       = "https://cloudnative-pg.github.io/charts"
  chart            = "cloudnative-pg"
  namespace        = "cnpg-system"
  create_namespace = true
}

resource "helm_release" "cert_manager" {
  name             = "cert-manager"
  repository       = "https://charts.jetstack.io"
  chart            = "cert-manager"
  namespace        = "cert-manager"
  create_namespace = true
  set {
    name  = "crds.enabled"
    value = "true"
  }
}

resource "helm_release" "ingress" {
  name             = "ingress-nginx"
  repository       = "https://kubernetes.github.io/ingress-nginx"
  chart            = "ingress-nginx"
  namespace        = "ingress-nginx"
  create_namespace = true
}

resource "kubernetes_secret" "factory_ca" {
  metadata {
    name      = "factory-client-ca"
    namespace = kubernetes_namespace.system.metadata[0].name
  }
  data = { "ca.crt" = var.factory_client_ca_pem }
}

# cell-control: the factory's only door into the cell. It creates one namespace per
# app and installs ../helm/app-backend there; it never returns end-user data.
resource "kubernetes_service_account" "cell_control" {
  metadata {
    name      = "cell-control"
    namespace = kubernetes_namespace.system.metadata[0].name
  }
}

resource "kubernetes_cluster_role_binding" "cell_control" {
  metadata { name = "banna-cell-control" }
  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = "cluster-admin" # narrow to namespaces + the app chart's kinds before go-live
  }
  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account.cell_control.metadata[0].name
    namespace = kubernetes_namespace.system.metadata[0].name
  }
}

resource "kubernetes_deployment" "cell_control" {
  metadata {
    name      = "cell-control"
    namespace = kubernetes_namespace.system.metadata[0].name
    labels    = local.labels
  }
  spec {
    replicas = 1
    selector { match_labels = { app = "cell-control" } }
    template {
      metadata { labels = { app = "cell-control" } }
      spec {
        service_account_name = kubernetes_service_account.cell_control.metadata[0].name
        container {
          name  = "cell-control"
          image = var.cell_control_image
          env {
            name  = "BACKUP_BUCKET_URL"
            value = var.backup_bucket_url
          }
          env {
            name  = "CLIENT_CA_PATH"
            value = "/etc/factory-ca/ca.crt"
          }
          port { container_port = 8443 }
          volume_mount {
            name       = "factory-ca"
            mount_path = "/etc/factory-ca"
            read_only  = true
          }
          resources {
            requests = { cpu = "100m", memory = "128Mi" }
            limits   = { cpu = "500m", memory = "256Mi" }
          }
        }
        volume {
          name = "factory-ca"
          secret { secret_name = kubernetes_secret.factory_ca.metadata[0].name }
        }
      }
    }
  }
}

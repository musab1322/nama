variable "kubeconfig_path" {
  type        = string
  description = "kubeconfig of the in-Kingdom cluster"
}

variable "kube_context" {
  type    = string
  default = null
}

variable "region_label" {
  type        = string
  description = "Saudi region of the cluster, recorded on every namespace (e.g. me-central2 / jeddah)"
}

variable "backup_bucket_url" {
  type        = string
  description = "Object storage INSIDE the Kingdom for database backups (s3-compatible URL)"
}

variable "cell_control_image" {
  type        = string
  description = "cell-control image, pinned by digest"
}

variable "factory_client_ca_pem" {
  type        = string
  sensitive   = true
  description = "CA that signed the factory's client certificate (mTLS: only the factory can call cell-control)"
}

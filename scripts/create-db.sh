#!/bin/bash
# Crea reporting_db y reporting_user en el MySQL del clúster. Se ejecuta EN el servidor (necesita kubectl).
# La contraseña del usuario se lee de la variable REPORTING_DB_PW; el script no guarda ni imprime ninguna.
# La del root se toma del propio pod de MySQL, igual que las demás bases del clúster.
#
#   read -rs REPORTING_DB_PW && export REPORTING_DB_PW      # pegar la contraseña nueva (no se muestra)
#   bash scripts/create-db.sh
#
# Idempotente (CREATE … IF NOT EXISTS): repetirlo no hace daño, pero NO cambia la contraseña de un usuario que ya existe;
# para rotarla: ALTER USER 'reporting_user'@'%' IDENTIFIED BY '…'; y volver a cifrar config/secrets.production.enc.
set -euo pipefail

: "${REPORTING_DB_PW:?Falta REPORTING_DB_PW (ver la cabecera del script)}"
# Va dentro de comillas simples de SQL: una comilla o una barra la romperían.
if [[ "$REPORTING_DB_PW" == *"'"* || "$REPORTING_DB_PW" == *'\'* || ${#REPORTING_DB_PW} -lt 16 ]]; then
  echo "La contraseña debe tener 16 caracteres o más y no llevar ' ni \\ (usa letras y números: openssl rand -hex 16)." >&2
  exit 1
fi

M=$(kubectl get pods -o name | grep mysql-basic | head -1)
[ -n "$M" ] || { echo "No encuentro el pod mysql-basic." >&2; exit 1; }
ROOT_PW=$(kubectl exec "$M" -- printenv MYSQL_ROOT_PASSWORD)

# El SQL viaja por stdin para que la contraseña nueva no aparezca en la lista de procesos.
kubectl exec -i "$M" -- mysql -uroot -p"$ROOT_PW" 2>&1 <<SQL | grep -v "Using a password" || true
CREATE DATABASE IF NOT EXISTS reporting_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'reporting_user'@'%' IDENTIFIED BY '${REPORTING_DB_PW}';
GRANT ALL PRIVILEGES ON reporting_db.* TO 'reporting_user'@'%';
FLUSH PRIVILEGES;
SQL

kubectl exec "$M" -- mysql -uroot -p"$ROOT_PW" -N -B -e \
  "SELECT schema_name FROM information_schema.schemata WHERE schema_name='reporting_db'; SELECT user FROM mysql.user WHERE user='reporting_user';" \
  2>&1 | grep -v "Using a password"

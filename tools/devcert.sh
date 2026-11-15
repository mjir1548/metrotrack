#!/bin/sh
# Génère une autorité de certification (CA) de DÉVELOPPEMENT et un certificat serveur
# signé par elle, dans dev/tls/ (ignoré par git : les clés privées ne sont jamais versionnées).
#   sh tools/devcert.sh [dossier_de_sortie]     (défaut : <projet>/dev/tls)
# Produits : ca.key, ca.crt (CA à épingler dans le simulateur / le boîtier),
#            server.key, server.crt (à référencer dans config.json, section tls).
# Clés EC P-256. Certificat serveur : SAN DNS:localhost, IP:127.0.0.1, IP:::1 ; usage serverAuth.
# La CA porte une contrainte de noms critique (localhost, 127.0.0.1, ::1) : même si sa clé
# fuit, elle ne peut pas servir à usurper un autre serveur.
# Ne convient PAS à la production : la CA de production sera gérée hors de ce dépôt.
# Paramètres à garder synchronisés avec test/tls-fixture.js.
set -eu
# Tout fichier créé (dont les clés privées) n'est lisible que par son propriétaire.
umask 077

OUT="${1:-$(cd "$(dirname "$0")/.." && pwd)/dev/tls}"
mkdir -p -- "$OUT"
cd -- "$OUT"
OUT="$(pwd)"

# Produits et fichiers de travail : aucun ne doit préexister (rien n'est jamais écrasé).
for f in ca.key ca.crt server.key server.crt openssl-dev.cnf server.csr ca.srl; do
  if [ -e "$f" ]; then
    echo "erreur : $OUT/$f existe déjà ; rien n'a été écrasé (supprimez ces fichiers pour régénérer)" >&2
    exit 1
  fi
done

# Nettoyage : fichiers de travail toujours supprimés ; en cas d'échec, suppression des
# produits créés par CETTE exécution (la vérification ci-dessus garantit qu'ils n'existaient pas).
created=""
cleanup() {
  status=$?
  rm -f -- openssl-dev.cnf server.csr ca.srl
  if [ "$status" -ne 0 ]; then
    for f in $created; do rm -f -- "$f"; done
    echo "erreur : génération interrompue ; fichiers partiels supprimés" >&2
  fi
}
trap cleanup EXIT

# Git Bash (MSYS) : ne pas convertir les arguments en chemins Windows. Tous les
# fichiers sont désignés par des chemins relatifs au dossier courant.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

cat > openssl-dev.cnf <<'CNF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = MetroTrack
[ca_ext]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical,permitted;DNS:localhost,permitted;IP:127.0.0.1/255.255.255.255,permitted;IP:::1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
[server_ext]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1,IP:::1
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
CNF

created="ca.key"
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key
created="$created ca.crt"
openssl req -config openssl-dev.cnf -new -x509 -key ca.key -subj "/CN=MetroTrack CA de developpement" \
  -days 3650 -sha256 -extensions ca_ext -out ca.crt
created="$created server.key"
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out server.key
openssl req -config openssl-dev.cnf -new -key server.key -subj "/CN=localhost" -out server.csr
created="$created server.crt"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 825 -sha256 -extfile openssl-dev.cnf -extensions server_ext -out server.crt
# Contrôle final : la chaîne est valide malgré la contrainte de noms.
openssl verify -CAfile ca.crt server.crt > /dev/null
chmod 644 ca.crt server.crt

echo "CA de développement : $OUT/ca.crt (clé : $OUT/ca.key)"
echo "Certificat serveur  : $OUT/server.crt (clé : $OUT/server.key)"
echo "Simulateur : node tools/simulateur.js --ca dev/tls/ca.crt ..."

# MongoDB on the VPS, reachable from Vercel

Target: AlmaLinux 9 with cPanel/WHM already running (Apache on 80/443, MariaDB
on 3306, CSF active). MongoDB is added alongside; nothing existing is changed.

Because the application runs on Vercel, MongoDB has to be reachable over the
public internet. **Vercel has no static IPs below Enterprise**, so the port
cannot be restricted to a known address. That makes TLS and authentication
mandatory rather than optional — an exposed MongoDB with no auth is found by
scanners within hours.

Run everything as root, via WHM → Server Configuration → Terminal, or SSH.

---

## 1. Install MongoDB 8.0

```bash
cat > /etc/yum.repos.d/mongodb-org-8.0.repo <<'EOF'
[mongodb-org-8.0]
name=MongoDB Repository
baseurl=https://repo.mongodb.org/yum/redhat/9/mongodb-org/8.0/x86_64/
gpgcheck=1
enabled=1
gpgkey=https://pgp.mongodb.com/server-8.0.asc
EOF

dnf install -y mongodb-org
mongod --version        # expect v8.0.x
```

8.0 is chosen deliberately: the dashboard uses `$unionWith` (4.4+) and the code
avoids the 8.0-only `$getField`, so 7.x would also work — but 8.0 is current.

---

## 2. A hostname for the certificate

Certificates are not issued for bare IP addresses, so the database needs a DNS
name. In cPanel/WHM create a subdomain — for example `db.yourdomain.com` — with
an A record pointing at `94.130.151.110`, then run **AutoSSL** on it.

Confirm it resolves before continuing:

```bash
dig +short db.yourdomain.com      # must print 94.130.151.110
```

---

## 3. Give mongod the certificate

MongoDB wants one PEM containing the private key and the certificate. cPanel
already builds that file for Apache:

```bash
mkdir -p /etc/ssl/mongodb
cat /var/cpanel/ssl/apache_tls/db.yourdomain.com/combined > /etc/ssl/mongodb/db.pem
chown mongod:mongod /etc/ssl/mongodb/db.pem
chmod 600 /etc/ssl/mongodb/db.pem
```

**Certificates renew roughly every 90 days, and mongod does not notice.** Without
this step the database stops accepting connections a few months from now, for
reasons that will not be obvious. Add a nightly refresh:

```bash
cat > /usr/local/bin/refresh-mongo-cert.sh <<'EOF'
#!/bin/bash
set -euo pipefail
SRC=/var/cpanel/ssl/apache_tls/db.yourdomain.com/combined
DST=/etc/ssl/mongodb/db.pem
# Only restart when the certificate has actually changed.
if ! cmp -s "$SRC" "$DST"; then
  cat "$SRC" > "$DST"
  chown mongod:mongod "$DST"
  chmod 600 "$DST"
  systemctl restart mongod
fi
EOF
chmod 700 /usr/local/bin/refresh-mongo-cert.sh
echo "30 3 * * * root /usr/local/bin/refresh-mongo-cert.sh" > /etc/cron.d/mongo-cert
```

---

## 4. Configure mongod

Replace `/etc/mongod.conf`:

```yaml
storage:
  dbPath: /var/lib/mongo
  wiredTiger:
    engineConfig:
      # NOT optional on this box. The default takes (RAM - 1GB) / 2, about
      # 14.5GB here, which would squeeze cPanel, MariaDB and the client's
      # sites. 4GB is generous: a year of data needs ~1.2GB of indexes.
      cacheSizeGB: 4

systemLog:
  destination: file
  path: /var/log/mongodb/mongod.log
  logAppend: true

net:
  # Non-default port. It does not stop a targeted attacker, but it removes the
  # host from the constant background scanning of 27017.
  port: 27019
  bindIp: 0.0.0.0
  tls:
    mode: requireTLS
    certificateKeyFile: /etc/ssl/mongodb/db.pem

security:
  authorization: enabled
```

---

## 5. Create the users

Authorisation has to be off just long enough to create the first user.

```bash
sed -i 's/^  authorization: enabled/  authorization: disabled/' /etc/mongod.conf
systemctl start mongod

mongosh --host 127.0.0.1 --port 27019 --tls --tlsAllowInvalidHostnames \
  --tlsCAFile /etc/ssl/mongodb/db.pem --eval '
db.getSiblingDB("admin").createUser({
  user: "mongoadmin",
  pwd: "REPLACE_WITH_A_LONG_RANDOM_PASSWORD",
  roles: [{ role: "userAdminAnyDatabase", db: "admin" }]
});
db.getSiblingDB("admin").createUser({
  user: "inventory_app",
  pwd: "REPLACE_WITH_ANOTHER_LONG_RANDOM_PASSWORD",
  // readWrite alone is not enough: ensureSchema uses collMod to maintain the
  // JSON-schema validators, and that lives in dbAdmin. Both are scoped to this
  // one database, so neither reaches anything else on the server.
  roles: [
    { role: "readWrite", db: "inventory" },
    { role: "dbAdmin",   db: "inventory" }
  ]
});'

sed -i 's/^  authorization: disabled/  authorization: enabled/' /etc/mongod.conf
systemctl restart mongod
systemctl enable mongod
```

Generate the passwords rather than inventing them:

```bash
openssl rand -base64 32
```

---

## 6. Open the port

```bash
# CSF: add 27019 to TCP_IN, then reload
sed -i 's/^TCP_IN = "\(.*\)"/TCP_IN = "\1,27019"/' /etc/csf/csf.conf
csf -r
```

Check nothing else was exposed by accident:

```bash
ss -tlnp | grep -E '27019|3306'
```

MariaDB on `0.0.0.0:3306` is pre-existing and worth raising separately with
whoever runs the server — it does not need to be internet-facing.

---

## 7. Verify from outside the server

From your laptop, not the VPS — this is the path Vercel will take:

```bash
mongosh "mongodb://inventory_app:PASSWORD@db.yourdomain.com:27019/inventory?authSource=admin&tls=true" \
  --eval 'db.runCommand({ping:1}); db.version()'
```

If that fails, work through it in order: DNS resolves, port open, TLS
handshake, credentials. A hostname mismatch between the certificate and the
connection string is the usual cause.

---

## 8. Point the application at it

In Vercel → Settings → Environment Variables:

```
MONGODB_URI=mongodb://inventory_app:PASSWORD@db.yourdomain.com:27019/inventory?authSource=admin&tls=true
SESSION_SECRET=<openssl rand -base64 48>
```

`SESSION_SECRET` must be set or every request throws — it is refused rather
than defaulted, so that no deployment silently shares a forgeable signing key.

Add `vercel.json` so the functions run near the database:

```json
{ "regions": ["fra1"] }
```

The VPS is in Falkenstein. Functions in `bom1` (Mumbai) pay ~130ms per round
trip, and a dashboard read makes about six — Frankfurt reduces that to ~15ms.

---

## 9. Seed the first admin

Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in Vercel temporarily, sign in once,
then change the password in the app and delete both variables. They are read
only while the `users` collection is empty.

---

## 10. Backups

Atlas was doing this silently. Nothing does it now.

```bash
cat > /usr/local/bin/backup-inventory.sh <<'EOF'
#!/bin/bash
set -euo pipefail
DEST=/var/backups/mongo
mkdir -p "$DEST"
mongodump --uri="mongodb://inventory_app:PASSWORD@127.0.0.1:27019/inventory?authSource=admin&tls=true&tlsAllowInvalidHostnames=true" \
  --archive="$DEST/inventory-$(date +%F).gz" --gzip
find "$DEST" -name 'inventory-*.gz' -mtime +14 -delete
EOF
chmod 700 /usr/local/bin/backup-inventory.sh
echo "15 2 * * * root /usr/local/bin/backup-inventory.sh" > /etc/cron.d/inventory-backup
```

Two things people skip, both of which make the backup worthless:

- **Copy them off the machine.** A backup stored only on the server it backs up
  does not survive the failure it exists for.
- **Test a restore**, once, into a scratch database:
  `mongorestore --archive=... --gzip --nsFrom='inventory.*' --nsTo='restoretest.*'`

---

## 11. Disk alert

The disk is 77% full (69GB free) with the client's sites on it. A full disk
takes down MongoDB *and* their websites. At ~12MB per day of sales the database
is not the risk — their data is — but the failure lands on you either way.

```bash
cat > /etc/cron.d/disk-alert <<'EOF'
0 * * * * root [ $(df --output=pcent / | tail -1 | tr -dc '0-9') -ge 85 ] && echo "Disk above 85% on $(hostname)" | mail -s "Disk warning" you@example.com
EOF
```

---

## Moving the data

You are re-uploading for the year backfill anyway, so the simplest path is to
upload through the app: **inventory sheet first** — it is the catalogue master
and the only source of `saleRate` — then sales, one month per file.

To move what exists instead:

```bash
# from your laptop, against Atlas
mongodump --uri="<atlas uri>" --archive=atlas.gz --gzip
mongorestore --uri="mongodb://inventory_app:PASSWORD@db.yourdomain.com:27019/?authSource=admin&tls=true" \
  --archive=atlas.gz --gzip
```

Keep the `users` collection either way, or put `ADMIN_USERNAME` /
`ADMIN_PASSWORD` back temporarily so the first admin can be seeded again.

---

## What this setup does and does not protect

**Does:** nobody reaches the data without credentials; traffic is encrypted;
the app user cannot touch anything outside its own database; deletion is
recoverable from backups.

**Does not:** anyone with root on this server can read or delete everything —
they can restart mongod with `--noauth`, or read the files directly.
Encryption at rest does not change that, because the key must live on the
machine. If the data must be protected from whoever administers the server, it
cannot live on their hardware.

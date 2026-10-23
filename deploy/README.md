# Deploying on a VPS

For a Debian or Ubuntu server you already have. Three files here: a systemd
unit, the environment file it reads, and an nginx site.

**None of it has been run.** The machine this was written on is not your
server, and no host has been named — so these are written from this project's
real layout and startup behaviour, not from a template, and the first run may
need a correction. Where a command's output matters, check it rather than
assuming.

If your hosting is not a VPS — Render, Railway, Fly, a Vercel function, a
cPanel host — say which and the specifics change (most of them replace the
systemd unit with a dashboard field and nginx with their own router). The
things that do not change: `DATABASE_URL` pooled, `DIRECT_URL` direct,
`SESSION_SECRET` from a secret store, migrations run separately before the app
starts, and one origin in front of both the app and the API.

## Once

```sh
# a user that owns nothing else
sudo adduser --system --group --home /opt/societybooks societybooks
sudo install -d -o societybooks -g societybooks /var/lib/societybooks

# node 22 and psql; the migration runner shells out to psql
sudo apt install -y nodejs npm postgresql-client-16 nginx

# the code
sudo -u societybooks git clone <your remote> /opt/societybooks
cd /opt/societybooks/society
sudo -u societybooks npm ci
sudo -u societybooks npm run server:build        # .server-build/
sudo -u societybooks npm run build               # dist/
sudo install -d /var/www/societybooks
sudo cp -r dist/* /var/www/societybooks/
```

Build the front end with the API on the same origin:

```sh
VITE_API_BASE="" VITE_DATA_SOURCE=server npm run build
```

`VITE_DATA_SOURCE=server` matters. Left unset, a deployment whose API is down
shows demonstration data instead of an error, and a committee reading invented
figures and believing them is the failure worth preventing.

## Credentials

```sh
sudo install -d -o societybooks -g societybooks -m 0750 /etc/societybooks
sudo install -o root -g societybooks -m 0640 \
  deploy/societybooks.env.example /etc/societybooks/api.env
sudo nano /etc/societybooks/api.env     # the two Neon URLs, SESSION_SECRET
```

Root owns it, the service's group reads it, nobody else can. It is not in the
repository and not in the unit file — a unit file is world-readable.

## The schema, before the app starts

```sh
cd /opt/societybooks/society
sudo -u societybooks env $(grep -v '^#' /etc/societybooks/api.env | xargs) \
  node server/migrate.mjs
```

Over `DIRECT_URL`, which is what the runner picks. Re-running it applies
nothing. Run `node server/migrate.mjs status` first if you want to see what it
would do.

## Start it

```sh
sudo cp deploy/societybooks-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now societybooks-api
systemctl status societybooks-api
curl -s localhost:4000/api/health
```

The unit binds to `127.0.0.1` on purpose: nginx is the only thing that should
reach it. It is hardened — read-only filesystem apart from
`/var/lib/societybooks`, no capabilities, no new privileges — because a process
that reads its own code and talks to a database needs nothing else.

## The site

```sh
sudo cp deploy/nginx-site.conf /etc/nginx/sites-available/societybooks
sudo ln -s /etc/nginx/sites-available/societybooks /etc/nginx/sites-enabled/
sudo certbot --nginx -d books.example.org
sudo nginx -t && sudo systemctl reload nginx
```

Then set `ALLOWED_ORIGIN=https://books.example.org` in the environment file and
restart the service. The API allows exactly that one origin to send cookies.

## Deploying a change

```sh
cd /opt/societybooks/society
sudo -u societybooks git pull
sudo -u societybooks npm ci
sudo -u societybooks npm run server:build
sudo -u societybooks env $(grep -v '^#' /etc/societybooks/api.env | xargs) \
  node server/migrate.mjs            # before the restart, never after
sudo systemctl restart societybooks-api
sudo -u societybooks env VITE_API_BASE="" VITE_DATA_SOURCE=server npm run build
sudo cp -r dist/* /var/www/societybooks/
```

Migrations before the restart. The other order leaves the new code running
against the old schema, which is where the interesting outages come from.

## Checking on it

```sh
journalctl -u societybooks-api -f                  # JSON lines, one per request
curl -s localhost:4000/api/health                   # 200, or 503 with the reason
```

With a treasurer or secretary session, `GET /api/system/database` reports the
connection in full — host, cipher, SCRAM mechanism, server version, applied
migrations, pool state — and no password.

Worth an alert, none of which exists here: a job in `scheduled_jobs` with
`state = 'failed'`, a row in `notifications` with `state = 'failed'`, and
`/api/health` returning 503.

## Backups

Neon keeps its own point-in-time history — check the retention on your plan,
because that is your real recovery window. Take your own dumps as well; a
provider's history does not protect you from a bad migration you then can't
identify. `server/README.md` has the `pg_dump`/`pg_restore` steps and the one
check worth running after a restore.

`societybooks-backup.service` and `.timer` take that dump every night at
02:30 IST and keep fourteen days in `/var/backups/societybooks`:

```
sudo install -m 0644 societybooks-backup.service societybooks-backup.timer /etc/systemd/system/
sudo install -d -o societybooks -g societybooks -m 0700 /var/backups/societybooks
sudo systemctl daemon-reload && sudo systemctl enable --now societybooks-backup.timer
systemctl list-timers societybooks-backup.timer   # when it runs next
```

The machine needs `postgresql-client` for `pg_dump`. A dump on the database's
own machine is lost with it: copy the files off the machine, and
rehearse a restore with `ADMIN_URL=... node scripts/verify-backup.mjs`.

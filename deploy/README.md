# Deploying

The stack (PostGIS, Martin, API, nginx with the static site) runs as the compose project
`historicalmap` on a small server. Images are built locally for linux/amd64 and shipped over SSH,
so no container registry and no tokens are involved.

```bash
cp deploy/deploy.env.example deploy/deploy.env   # git-ignored: host, user, key path
deploy/deploy.sh        # build + ship + (re)start; generates the DB password on the server (once)
deploy/load-data.sh     # dump the local database, upload (resumable), restore, restart Martin
```

Nothing secret is stored in the repository: server access lives in `deploy/deploy.env` (ignored) and the
only secret, the database password, is generated on the server in `$DEPLOY_DIR/.env`.

Only the web container publishes a port (`WEB_PORT`, default 8082); the database, Martin and the API stay on
the private compose network. Every container has a memory limit so this stack cannot starve the other
apps on the box. The tile cache lives in the web container and is dropped on every deploy / data load.

## Several apps on one IP, with different domain names

The idea: every domain points (DNS `A` record) to the same IP, and **one** reverse proxy owns ports 80
and 443. It reads the `Host` header of each request and forwards it to the right app, which listens on its
own local port. TLS certificates are issued per domain.

```
browser ──► app-one.example   ─┐
browser ──► app-two.example   ─┼─► 203.0.113.10:443 ─► edge nginx ─┬─► 127.0.0.1:8080  (app one)
browser ──► history.example   ─┘                                   ├─► 127.0.0.1:8081  (app two)
                                                                   └─► 127.0.0.1:8082  (this app)
```

On this server the proxy is the `edge-proxy` container (nginx, host network, config in
`/root/edge-proxy/default.conf`, certificates in `/etc/letsencrypt`, ACME webroot in
`/root/edge-proxy/webroot`). To add a domain:

1. **DNS:** create an `A` record `history.example → <server IP>` (and `www` if wanted); wait for it to resolve.
2. **App port:** the app listens on a free local port (here `WEB_PORT=8082`). Bind it to localhost only once the
   proxy is in front: set `WEB_BIND=127.0.0.1` in `$DEPLOY_DIR/.env` and redeploy.
3. **HTTP block + certificate:** add this to `/root/edge-proxy/default.conf`, reload, and request the certificate:

   ```nginx
   server {
       listen 80;
       server_name history.example www.history.example;
       location /.well-known/acme-challenge/ { root /var/www/certbot; }
       location / { return 301 https://$host$request_uri; }
   }
   ```

   ```bash
   docker exec edge-proxy nginx -t && docker exec edge-proxy nginx -s reload
   certbot certonly --webroot -w /root/edge-proxy/webroot -d history.example -d www.history.example
   ```

4. **HTTPS block:** add and reload again:

   ```nginx
   server {
       listen 443 ssl;
       server_name history.example www.history.example;
       ssl_certificate     /etc/letsencrypt/live/history.example/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/history.example/privkey.pem;

       location / {
           proxy_pass http://127.0.0.1:8082;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```

   ```bash
   docker exec edge-proxy nginx -t && docker exec edge-proxy nginx -s reload
   ```

Renewals are automatic (`certbot.timer`); the proxy only needs a reload to pick up a renewed certificate
(`certbot renew --deploy-hook "docker exec edge-proxy nginx -s reload"`).

Things to watch: the block with `default_server` answers every request whose `Host` matches no
`server_name` (including plain-IP access), so keep each app's `server_name` exact; each new app needs RAM,
so check `free -m` and the per-container limits before adding one; the firewall (`ufw`) is currently inactive,
so every published port is reachable from the internet; publish app ports on `127.0.0.1` once a proxy fronts them.

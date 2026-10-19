# Static project page served by Caddy. Build context is the repo root
# so the README and mascot assets stay in sync with the repo.
FROM caddy:2.8.4-alpine

COPY site/Caddyfile /etc/caddy/Caddyfile
COPY site/index.html /srv/index.html
COPY README.md /srv/README.md
COPY assets /srv/assets

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

# Static site + reverse proxy. The site (apps/web/dist) is built on the host by deploy/deploy.sh,
# so the image build is only a copy and works for any target architecture.
FROM nginx:alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web/dist /usr/share/nginx/html

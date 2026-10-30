# Development only: fake live HLS streams for every table (test pattern + table name + clock),
# so the game pages' video player can be tested without the casino's video CDN.
FROM nginx:1.27-alpine
RUN apk add --no-cache ffmpeg font-dejavu
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY streams.sh /streams.sh
RUN chmod +x /streams.sh
CMD ["/streams.sh"]

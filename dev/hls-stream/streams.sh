#!/bin/sh
# One ffmpeg process encodes a 640x360 live placeholder stream per table (felt-green background,
# table name, clock) into /srv/hls/<app>-<table>.m3u8
# (matches HLS_URL_TEMPLATE=http://localhost:8080/hls/{app}-{table}.m3u8), then nginx serves them.
set -e
TABLES="${TABLES:-baccarat-1 baccarat-2 dragon-tiger-1 dragon-tiger-2 poker-1 poker-2}"
OUT=/srv/hls
FONT=/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf
mkdir -p "$OUT"
rm -f "$OUT"/*

n=$(echo $TABLES | wc -w)
split_v=""; split_a=""; filters=""; maps=""; i=0
for t in $TABLES; do
	label=$(echo "$t" | sed 's/-\([0-9]*\)$/ #\1/' | tr 'a-z' 'A-Z')
	split_v="$split_v[v$i]"; split_a="$split_a[a$i]"
	filters="$filters;[v$i]drawtext=fontfile=$FONT:text='$label':fontsize=40:fontcolor=0xe6c96a:box=1:boxcolor=black@0.35:boxborderw=12:x=(w-tw)/2:y=60,drawtext=fontfile=$FONT:text='%{localtime\:%H\\\\\:%M\\\\\:%S}':fontsize=22:fontcolor=white@0.8:box=1:boxcolor=black@0.35:boxborderw=8:x=(w-tw)/2:y=118[o$i]"
	maps="$maps -map [o$i] -map [a$i] -c:v libx264 -preset veryfast -tune zerolatency -profile:v main -pix_fmt yuv420p -g 50 -keyint_min 50 -sc_threshold 0 -b:v 600k -c:a aac -b:a 64k -f hls -hls_time 2 -hls_list_size 6 -hls_flags delete_segments+omit_endlist -hls_segment_filename $OUT/$t-%05d.ts $OUT/$t.m3u8"
	i=$((i + 1))
done

ffmpeg -hide_banner -loglevel warning -re \
	-f lavfi -i "gradients=size=640x360:rate=25:c0=0x1d6b4a:c1=0x05231a:type=radial:x0=320:y0=150:x1=0:y1=360:speed=0.002" \
	-f lavfi -i "sine=frequency=330:sample_rate=44100,volume=0.05" \
	-filter_complex "[0:v]split=$n$split_v;[1:a]asplit=$n$split_a$filters" \
	$maps &

exec nginx -g 'daemon off;'

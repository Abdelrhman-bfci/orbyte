ARG NODE_VERSION=24.22.1
FROM node:${NODE_VERSION}-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential \
		ca-certificates \
		fakeroot \
		g++ \
		git \
		libasound2 \
		libgbm1 \
		libgomp1 \
		libgtk-3-0 \
		libkrb5-dev \
		libnss3 \
		libsecret-1-dev \
		libssl3 \
		libx11-dev \
		libx11-xcb-dev \
		libxkbfile-dev \
		pkg-config \
		python-is-python3 \
		rpm \
		rsync \
	&& rm -rf /var/lib/apt/lists/*

RUN corepack enable \
	&& corepack prepare pnpm@12.16.0 --activate

COPY build.sh /usr/local/bin/orbyte-linux-build
RUN chmod +x /usr/local/bin/orbyte-linux-build

ENTRYPOINT ["/usr/local/bin/orbyte-linux-build"]
